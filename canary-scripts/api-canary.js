'use strict';

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const config = require('./lib/config');
const assertions = require('./lib/assertions');

/**
 * API canary.
 *
 * Calls one HTTP endpoint on a schedule and asserts the whole contract, not
 * just reachability: the status code, optionally the shape of the JSON body,
 * the absence of an error signature in an otherwise successful response, the
 * response time against a budget, and how much certificate lifetime is left.
 *
 * The assertions live here rather than in the Terraform because they are the
 * part that changes when the service does. Infrastructure decides which
 * endpoints are watched and how often; the script decides what "healthy"
 * means for them.
 *
 * Configuration, all through the canary's environment variables:
 *
 *   TARGET_URL                 required, the absolute URL to call
 *   EXPECTED_STATUS            default 200; "204", "200,201", "2xx", "200-299", "any"
 *   REQUEST_METHOD             default GET
 *   REQUEST_HEADERS            JSON object of headers; a User-Agent is added if absent
 *   REQUEST_BODY               raw request body, for a POST or PUT check
 *   LATENCY_BUDGET_MS          default 0 (off); fails the run when exceeded
 *   BODY_MUST_CONTAIN          text that must appear in the response body
 *   BODY_ERROR_PATTERNS        comma-separated signatures that must NOT appear;
 *                              the single word "none" turns the check off
 *   EXPECT_JSON_FIELDS         JSON object of dotted path to expected value
 *   CERT_EXPIRY_WARNING_DAYS   default 14; 0 disables the check
 *   TAKE_SCREENSHOT            default false; this check makes no page visit
 */

/** Signatures that mean an error even when the status code says otherwise. */
const DEFAULT_ERROR_PATTERNS = [
  'internal server error',
  'service unavailable',
  'gateway timeout',
  'an unexpected error occurred',
];

const USER_AGENT = 'synthetic-api-check';

/**
 * The only value that turns the body-signature check off.
 *
 * Clearing the variable does not do it. An empty or whitespace-only value
 * reads as absent everywhere in this bundle, and absent means "use the
 * defaults" — so an operator silencing a false positive by blanking the
 * variable gets the four defaults back and the check keeps firing, with
 * nothing anywhere saying why. A word has to be written for "none", because
 * the absence of a value cannot distinguish "unset" from "deliberately empty".
 */
const DISABLE_BODY_PATTERNS = 'none';

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string[]}
 */
function readBodyErrorPatterns(options = {}) {
  const configured = config.list('BODY_ERROR_PATTERNS', {
    env: options.env,
    fallback: DEFAULT_ERROR_PATTERNS,
  });
  if (configured.length === 1 && configured[0].toLowerCase() === DISABLE_BODY_PATTERNS) {
    return [];
  }
  return configured;
}

/**
 * Reads and validates every input before the first request is made.
 *
 * Parsing up front means a misconfigured canary fails on its opening run with
 * a message naming the variable, rather than on the first run where the bad
 * value happens to matter.
 *
 * @returns {{
 *   targetUrl: string,
 *   expectedStatus: string,
 *   method: string,
 *   headers: Record<string, string>,
 *   body: string | null,
 *   latencyBudgetMs: number,
 *   bodyMustContain: string | null,
 *   bodyErrorPatterns: string[],
 *   expectedJsonFields: Record<string, unknown>,
 *   certExpiryWarningDays: number,
 *   takeScreenshot: boolean,
 * }}
 */
function readConfiguration() {
  const expectedJsonFields = config.json('EXPECT_JSON_FIELDS', { fallback: {} });
  if (expectedJsonFields === null || typeof expectedJsonFields !== 'object' || Array.isArray(expectedJsonFields)) {
    throw new config.ConfigurationError('EXPECT_JSON_FIELDS must be a JSON object of dotted paths to expected values.');
  }

  return {
    targetUrl: config.requiredUrl('TARGET_URL'),
    expectedStatus: config.optionalString('EXPECTED_STATUS', '200') ?? '200',
    method: (config.optionalString('REQUEST_METHOD', 'GET') ?? 'GET').toUpperCase(),
    headers: config.headers({ userAgent: USER_AGENT }),
    body: config.optionalString('REQUEST_BODY'),
    latencyBudgetMs: config.integer('LATENCY_BUDGET_MS', { fallback: 0, min: 0 }),
    bodyMustContain: config.optionalString('BODY_MUST_CONTAIN'),
    bodyErrorPatterns: readBodyErrorPatterns(),
    expectedJsonFields: /** @type {Record<string, unknown>} */ (expectedJsonFields),
    certExpiryWarningDays: config.integer('CERT_EXPIRY_WARNING_DAYS', { fallback: 14, min: 0 }),
    takeScreenshot: config.boolean('TAKE_SCREENSHOT', { fallback: false }),
  };
}

/**
 * Turns an absolute URL into the request options the step helper takes.
 *
 * @param {string} targetUrl
 * @param {ReturnType<typeof readConfiguration>} settings
 * @returns {Record<string, unknown>}
 */
function buildRequestOptions(targetUrl, settings) {
  const parsed = new URL(targetUrl);
  return {
    hostname: parsed.hostname,
    method: settings.method,
    path: `${parsed.pathname}${parsed.search}`,
    port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port),
    protocol: parsed.protocol,
    headers: settings.headers,
    body: settings.body ?? undefined,
  };
}

/**
 * Reads a response body to the end.
 *
 * The step helper hands back a stream and will not settle until it is
 * consumed, so this is not optional even for a check that ignores the body.
 *
 * @param {import('node:http').IncomingMessage} response
 * @returns {Promise<string>}
 */
function readBody(response) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
}

/**
 * Certificate lifetime, read off the socket the response arrived on.
 *
 * Returns null on a plaintext connection or where the runtime does not expose
 * the peer certificate, which is a reason to skip the check rather than to
 * fail the run.
 *
 * @param {import('node:http').IncomingMessage} response
 * @returns {{ validTo: string, subject: string } | null}
 */
function peerCertificate(response) {
  const socket = /** @type {import('node:tls').TLSSocket | undefined} */ (response.socket);
  if (!socket || typeof socket.getPeerCertificate !== 'function') {
    return null;
  }
  const certificate = socket.getPeerCertificate();
  if (!certificate || !certificate.valid_to) {
    return null;
  }
  return {
    validTo: certificate.valid_to,
    subject: certificate.subject && certificate.subject.CN ? certificate.subject.CN : '',
  };
}

/**
 * Applies every configured assertion to one response.
 *
 * Ordering is not arbitrary. The status check runs first because a 502 makes
 * every body assertion meaningless noise, and the certificate check runs last
 * because an expiring certificate is a warning about the future while the
 * others are statements about the present.
 *
 * @param {import('node:http').IncomingMessage} response
 * @param {string} body
 * @param {number} latencyMs
 * @param {ReturnType<typeof readConfiguration>} settings
 * @returns {void}
 */
function applyAssertions(response, body, latencyMs, settings) {
  const context = { url: settings.targetUrl, latencyMs };
  const status = response.statusCode ?? 0;

  assertions.assertStatus(status, settings.expectedStatus, context);
  assertions.assertBodyClean(body, settings.bodyErrorPatterns, context);

  if (settings.bodyMustContain) {
    assertions.assertBodyContains(body, settings.bodyMustContain, context);
  }

  if (Object.keys(settings.expectedJsonFields).length > 0) {
    let document;
    try {
      document = JSON.parse(body);
    } catch (error) {
      throw new assertions.AssertionFailure(
        `EXPECT_JSON_FIELDS is set but the response body is not JSON: ${/** @type {Error} */ (error).message}`,
        context,
      );
    }
    assertions.assertJsonFields(document, settings.expectedJsonFields, context);
  }

  assertions.assertLatencyWithin(latencyMs, settings.latencyBudgetMs, context);

  const certificate = peerCertificate(response);
  if (certificate === null) {
    log.info('No peer certificate on this connection; the expiry check was skipped.');
    return;
  }
  const remaining = assertions.assertCertificateLifetime(certificate.validTo, settings.certExpiryWarningDays, {
    host: new URL(settings.targetUrl).hostname,
  });
  log.info(`Certificate for ${certificate.subject || 'the endpoint'} has ${remaining} days left.`);
}

/**
 * @returns {Promise<string>}
 */
const apiCanary = async function () {
  const settings = readConfiguration();

  // Screenshots are off by default: this check never opens a page, so the
  // capture would be of an empty viewport while still costing a write to the
  // artifacts bucket on every run.
  synthetics
    .getConfiguration()
    .withScreenshotOnStepStart(settings.takeScreenshot)
    .withScreenshotOnStepSuccess(settings.takeScreenshot)
    .withScreenshotOnStepFailure(settings.takeScreenshot);

  const requestOptions = buildRequestOptions(settings.targetUrl, settings);
  log.info(`Calling ${settings.method} ${settings.targetUrl}, expecting ${settings.expectedStatus}.`);

  // Timing is taken inside the validation callback, at the point the body has
  // finished arriving. Measuring around the step call instead would give a
  // number that is only available after every assertion has already run, so
  // the latency budget would silently never be enforced.
  const startedAt = process.hrtime.bigint();
  let latencyMs = 0;

  /**
   * @param {import('node:http').IncomingMessage} response
   * @returns {Promise<void>}
   */
  const validate = async function (response) {
    const body = await readBody(response);
    latencyMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    applyAssertions(response, body, latencyMs, settings);
  };

  await synthetics.executeHttpStep('contract', requestOptions, validate, {
    // The request body is recorded; response bodies are not. A response can
    // carry personal data, and the artifacts bucket is not the place to
    // accumulate it one run at a time.
    includeRequestBody: settings.body !== null,
    includeResponseBody: false,
    includeRequestHeaders: true,
    includeResponseHeaders: true,
    restrictedHeaders: ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'],
    continueOnHttpStepFailure: false,
  });

  const outcome = `${settings.method} ${settings.targetUrl} satisfied its contract in ${latencyMs} ms.`;
  log.info(outcome);
  return outcome;
};

exports.handler = async () => apiCanary();
