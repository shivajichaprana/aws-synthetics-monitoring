'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCanary, withEnv } = require('../support/runtime');
const { startServer } = require('../support/server');

/**
 * The API canary, run end to end against a real local endpoint.
 *
 * These tests exercise the committed script, unmodified, with only the two
 * bare modules the Synthetics service provides replaced. That matters because
 * the parts worth checking here are not in `lib/` at all: which variables are
 * read, what the defaults are, the order the assertions run in, and whether the
 * response body is drained before anything is concluded about it.
 *
 * Every case is written in both directions. A canary that cannot fail is
 * indistinguishable from a service that never breaks, and it produces the same
 * green square, so a test that only proves the happy path proves very little.
 */

/**
 * @param {Record<string, string>} env
 * @param {Record<string, any>} routes
 * @returns {Promise<{ outcome: string | null, error: Error | null, runtime: any, server: any }>}
 */
async function run(env, routes) {
  const server = await startServer(routes);
  const { module, runtime } = loadCanary('api-canary.js');

  try {
    const outcome = await withEnv({ TARGET_URL: `${server.origin}/health`, ...env }, () => module.handler());
    return { outcome, error: null, runtime, server };
  } catch (error) {
    return { outcome: null, error: /** @type {Error} */ (error), runtime, server };
  } finally {
    await server.close();
  }
}

const OK_JSON = {
  '/health': {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"status":"ok","data":{"count":2,"ready":true}}',
  },
};

test('a healthy endpoint passes and the step is named for the contract', async () => {
  const { outcome, error, runtime } = await run({}, OK_JSON);

  assert.equal(error, null);
  assert.match(String(outcome), /satisfied its contract/);
  // The step name is not cosmetic: the latency alarm scopes the Duration
  // metric to a StepName dimension, so renaming it here silently detaches the
  // alarm from the metric it watches.
  assert.deepEqual(runtime.stepNames(), ['contract']);
});

test('the request is built from the target URL, method and headers', async () => {
  const { runtime, server } = await run(
    { REQUEST_METHOD: 'post', REQUEST_BODY: '{"ping":1}', REQUEST_HEADERS: '{"x-check":"yes"}' },
    { '/health': { status: 200, body: 'ok' } },
  );

  const [step] = runtime.httpSteps;
  assert.equal(step.requestOptions.method, 'POST', 'the verb is upper-cased');
  assert.equal(step.requestOptions.path, '/health');
  assert.equal(step.requestOptions.port, server.port);
  assert.equal(step.requestOptions.headers['x-check'], 'yes');
  // A synthetic request that is not labelled is indistinguishable from real
  // traffic in the origin's logs, and it skews every request-rate panel these
  // same dashboards plot.
  assert.equal(step.requestOptions.headers['User-Agent'], 'synthetic-api-check');
  assert.equal(server.received[0].body, '{"ping":1}');
});

test('a query string is carried into the request path', async () => {
  const server = await startServer({ '/health': { status: 200, body: 'ok' } });
  const { module, runtime } = loadCanary('api-canary.js');
  try {
    await withEnv({ TARGET_URL: `${server.origin}/health?deep=1&n=2` }, () => module.handler());
    assert.equal(runtime.httpSteps[0].requestOptions.path, '/health?deep=1&n=2');
  } finally {
    await server.close();
  }
});

test('the default expectation is exactly 200, not any success', async () => {
  const { error } = await run({}, { '/health': { status: 204, body: '' } });
  assert.ok(error, 'a 204 is not a 200');
  assert.match(String(error && error.message), /204/);
});

test('a widened expectation accepts what the default refuses', async () => {
  const { error, outcome } = await run({ EXPECTED_STATUS: '2xx' }, { '/health': { status: 204, body: '' } });
  assert.equal(error, null);
  assert.ok(outcome);
});

test('a failing status names the observed code and the expectation', async () => {
  const { error } = await run({}, { '/health': { status: 503, body: 'upstream gone' } });
  assert.match(String(error && error.message), /Expected status 200/);
  assert.match(String(error && error.message), /received 503/);
});

test('an error signature in a 200 body fails the run', async () => {
  // This is the check a status monitor cannot make. A service answering 200
  // with a rendered error page is down, and availability built on status codes
  // alone records those minutes as healthy.
  const { error } = await run({}, {
    '/health': { status: 200, body: '<h1>Internal Server Error</h1>' },
  });
  assert.match(String(error && error.message), /internal server error/i);
});

test('the body-signature check is turned off by the word none, not by clearing it', async () => {
  const body = { '/health': { status: 200, body: 'service unavailable, retrying' } };

  // Blanking the variable hands back the defaults, because an empty value
  // reads as absent everywhere in this bundle and absent means "use the
  // defaults". An operator silencing a false positive that way would see the
  // check keep firing with nothing saying why.
  const cleared = await run({ BODY_ERROR_PATTERNS: '  ' }, body);
  assert.ok(cleared.error, 'clearing the variable must not silently disable the check');

  const disabled = await run({ BODY_ERROR_PATTERNS: 'none' }, body);
  assert.equal(disabled.error, null, '"none" is the documented way to disable it');

  const alsoDisabled = await run({ BODY_ERROR_PATTERNS: 'NONE' }, body);
  assert.equal(alsoDisabled.error, null, 'and it is case-insensitive');

  // The assertion that actually separates the two readings. Without the
  // sentinel, "none" is a pattern like any other and this body matches it — so
  // a response that merely uses the word would fail, which is the behaviour
  // being ruled out rather than a body chosen to avoid it.
  const sentinelNotAPattern = await run(
    { BODY_ERROR_PATTERNS: 'none' },
    { '/health': { status: 200, body: 'degraded services: none' } },
  );
  assert.equal(sentinelNotAPattern.error, null, '"none" disables the check, it does not become the pattern');
});

test('a custom signature list replaces the defaults rather than adding to them', async () => {
  const { error } = await run(
    { BODY_ERROR_PATTERNS: 'quota exceeded' },
    { '/health': { status: 200, body: 'internal server error' } },
  );
  assert.equal(error, null, 'the default signatures are no longer in effect');

  const custom = await run(
    { BODY_ERROR_PATTERNS: 'quota exceeded' },
    { '/health': { status: 200, body: 'QUOTA EXCEEDED for this key' } },
  );
  assert.ok(custom.error);
});

test('a signature is matched however either side is capitalised', async () => {
  const { error } = await run(
    { BODY_ERROR_PATTERNS: 'Quota Exceeded' },
    { '/health': { status: 200, body: 'quota exceeded for this key' } },
  );
  assert.match(String(error && error.message), /Quota Exceeded/);
});

test('BODY_MUST_CONTAIN is checked against the response body', async () => {
  const present = await run({ BODY_MUST_CONTAIN: 'ok' }, OK_JSON);
  assert.equal(present.error, null);

  const absent = await run({ BODY_MUST_CONTAIN: 'ready-for-traffic' }, OK_JSON);
  assert.match(String(absent.error && absent.error.message), /ready-for-traffic/);
});

test('JSON field expectations are read by dotted path', async () => {
  const good = await run({ EXPECT_JSON_FIELDS: '{"status":"ok","data.count":2,"data.ready":true}' }, OK_JSON);
  assert.equal(good.error, null);

  const bad = await run({ EXPECT_JSON_FIELDS: '{"data.count":3}' }, OK_JSON);
  assert.match(String(bad.error && bad.error.message), /data\.count/);
});

test('JSON field expectations on a body that is not JSON say so', async () => {
  const { error } = await run(
    { EXPECT_JSON_FIELDS: '{"status":"ok"}' },
    { '/health': { status: 200, body: 'plain text' } },
  );
  assert.match(String(error && error.message), /EXPECT_JSON_FIELDS is set but the response body is not JSON/);
});

test('a JSON expectation is not defeated by the order of an object', async () => {
  // A service is free to reorder an object's members between two responses
  // that say the same thing, and it would be a false failure if it did.
  const { error } = await run({ EXPECT_JSON_FIELDS: '{"data":{"ready":true,"count":2}}' }, OK_JSON);
  assert.equal(error, null);
});

test('the latency budget is actually enforced, and off by default', async () => {
  // Timing is taken inside the validation callback. Measuring around the step
  // instead would produce a number only available after every assertion had
  // already run, so the budget would silently never be applied.
  const slow = { '/health': { status: 200, body: 'ok', delayMs: 250 } };

  const unbudgeted = await run({}, slow);
  assert.equal(unbudgeted.error, null, 'no budget means no latency check');

  const budgeted = await run({ LATENCY_BUDGET_MS: '50' }, slow);
  assert.match(String(budgeted.error && budgeted.error.message), /50 ms budget/);
});

test('a plaintext connection skips the certificate check instead of failing', async () => {
  // There is no peer certificate to read, which is a reason to skip rather
  // than to report an outage.
  const { error, runtime } = await run({ CERT_EXPIRY_WARNING_DAYS: '365' }, OK_JSON);
  assert.equal(error, null);
  assert.ok(runtime.logged('No peer certificate'));
});

test('an unset target is refused before any request is made', async () => {
  const { module } = loadCanary('api-canary.js');
  await assert.rejects(
    () => withEnv({}, () => module.handler()),
    (/** @type {Error} */ error) => error.name === 'ConfigurationError' && error.message.includes('TARGET_URL'),
  );
});

test('a target that is not an absolute HTTP URL is refused by name', async () => {
  const { module } = loadCanary('api-canary.js');
  for (const target of ['api.example.test/health', 'file:///etc/hosts']) {
    await assert.rejects(
      () => withEnv({ TARGET_URL: target }, () => module.handler()),
      (/** @type {Error} */ error) => error.name === 'ConfigurationError',
      target,
    );
  }
});

test('a malformed expectation is refused rather than treated as no expectation', async () => {
  const { module } = loadCanary('api-canary.js');
  await assert.rejects(
    () =>
      withEnv({ TARGET_URL: 'https://api.example.test/', EXPECT_JSON_FIELDS: '[1,2]' }, () => module.handler()),
    (/** @type {Error} */ error) => error.message.includes('EXPECT_JSON_FIELDS'),
  );
});

test('response bodies are never recorded and credentials are restricted', async () => {
  // A response can carry personal data, and the artifacts bucket is not the
  // place to accumulate it one run at a time.
  const { runtime } = await run({ REQUEST_BODY: '{"a":1}', REQUEST_METHOD: 'POST' }, OK_JSON);
  const { stepConfig } = runtime.httpSteps[0];

  assert.equal(stepConfig.includeResponseBody, false);
  assert.equal(stepConfig.includeRequestBody, true, 'a request body that exists is worth recording');
  assert.equal(stepConfig.continueOnHttpStepFailure, false);
  for (const header of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) {
    assert.ok(stepConfig.restrictedHeaders.includes(header), header);
  }
});

test('the request body is not marked for recording when there is none', async () => {
  const { runtime } = await run({}, OK_JSON);
  assert.equal(runtime.httpSteps[0].stepConfig.includeRequestBody, false);
});

test('screenshots are off by default, because this check opens no page', async () => {
  const { runtime } = await run({}, OK_JSON);
  assert.equal(runtime.configuration.withScreenshotOnStepStart, false);
  assert.equal(runtime.configuration.withScreenshotOnStepSuccess, false);
  assert.equal(runtime.configuration.withScreenshotOnStepFailure, false);

  const asked = await run({ TAKE_SCREENSHOT: 'true' }, OK_JSON);
  assert.equal(asked.runtime.configuration.withScreenshotOnStepFailure, true);
});
