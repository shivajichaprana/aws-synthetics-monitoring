'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * A single HTTP request with a hard timeout and explicit redirect handling.
 *
 * The Synthetics runtime ships `executeHttpStep`, and the API canary uses it,
 * because it writes each request into the run's report and HAR file. This
 * probe exists for the case that helper is deliberately unsuited to: checking
 * many URLs where a failure must be recorded and the run must carry on. A
 * step-based helper fails the step on the first bad link, so a page with
 * twelve broken links reports one.
 *
 * Nothing here depends on the Synthetics runtime, so the retry, timeout and
 * redirect behaviour can be tested against a local server.
 */

/** @typedef {{
 *   url: string,
 *   status: number | null,
 *   latencyMs: number,
 *   redirects: number,
 *   finalUrl: string,
 *   error: string | null,
 *   headers: Record<string, string | string[] | undefined>,
 *   body: string,
 *   certificate: { validTo: string, subject: string } | null,
 * }} ProbeResult */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Caps how much of a response body is buffered.
 *
 * A canary asserts on a signature near the top of a body; it has no reason to
 * hold a 40 MB download in a 960 MB function.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Performs one request, without following redirects.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   body?: string | null,
 *   captureBody?: boolean,
 * }} [options]
 * @returns {Promise<ProbeResult>}
 */
function requestOnce(url, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const captureBody = options.captureBody ?? true;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(failure(url, 0, `"${url}" is not a valid URL.`));
      return;
    }

    // The scheme is checked before a client is chosen. `http.request` throws
    // synchronously on an unsupported protocol, and a throw here would reject
    // the promise rather than resolve it with a result — which would take the
    // whole batch down over one unusable href, the exact failure this probe
    // exists to avoid.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve(failure(url, 0, `"${parsed.protocol}" is not an HTTP scheme.`));
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const startedAt = process.hrtime.bigint();
    /** @type {boolean} */
    let settled = false;

    /** @param {ProbeResult} result */
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1000000n);

    /** @type {import('node:http').ClientRequest} */
    let request;
    try {
      request = transport.request(parsed, { method, headers: options.headers ?? {} }, (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let bytes = 0;

        if (!captureBody) {
          response.resume();
        } else {
          response.on('data', (chunk) => {
            if (bytes >= MAX_BODY_BYTES) {
              return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
          });
        }

        response.on('end', () => {
          finish({
            url,
            status: response.statusCode ?? null,
            latencyMs: elapsedMs(),
            redirects: 0,
            finalUrl: url,
            error: null,
            headers: response.headers,
            body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'),
            certificate: readCertificate(response),
          });
        });

        response.on('error', (error) => {
          finish(failure(url, elapsedMs(), error.message));
        });
      });
    } catch (error) {
      // Anything the client rejects outright — an unsupported option, a header
      // name the runtime refuses — is reported the same way a network failure
      // is, so a caller iterating over many URLs never has to catch.
      finish(failure(url, elapsedMs(), /** @type {Error} */ (error).message));
      return;
    }

    // `timeout` only fires on socket inactivity, so the socket is destroyed
    // explicitly; without that, a server holding the connection open keeps the
    // canary running until the service-side run timeout kills it, and the run
    // reports a timeout rather than a slow endpoint.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`No response within ${timeoutMs} ms.`));
    });

    request.on('error', (error) => {
      finish(failure(url, elapsedMs(), error.message));
    });

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

/**
 * Reads the peer certificate from a TLS response, when there is one.
 *
 * @param {import('node:http').IncomingMessage} response
 * @returns {{ validTo: string, subject: string } | null}
 */
function readCertificate(response) {
  const socket = /** @type {import('node:tls').TLSSocket} */ (response.socket);
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
 * @param {string} url
 * @param {number} latencyMs
 * @param {string} message
 * @returns {ProbeResult}
 */
function failure(url, latencyMs, message) {
  return {
    url,
    status: null,
    latencyMs,
    redirects: 0,
    finalUrl: url,
    error: message,
    headers: {},
    body: '',
    certificate: null,
  };
}

/**
 * Performs a request, following redirects up to a cap.
 *
 * The number of hops and the address finally reached are both reported, so a
 * check that cares about either can assert on it. When `followRedirects` is
 * false the first response is returned as-is, which is what lets a link
 * checker distinguish a redirect from a success.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   body?: string | null,
 *   captureBody?: boolean,
 *   followRedirects?: boolean,
 *   maxRedirects?: number,
 * }} [options]
 * @returns {Promise<ProbeResult>}
 */
async function probe(url, options = {}) {
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = url;
  let redirects = 0;
  let totalLatencyMs = 0;

  for (;;) {
    const result = await requestOnce(current, options);
    totalLatencyMs += result.latencyMs;

    const isRedirect =
      result.status !== null && result.status >= 300 && result.status < 400 && Boolean(result.headers.location);

    if (!followRedirects || !isRedirect) {
      return { ...result, redirects, latencyMs: totalLatencyMs, finalUrl: current, url };
    }

    if (redirects >= maxRedirects) {
      return {
        ...failure(url, totalLatencyMs, `More than ${maxRedirects} redirects, last at ${current}.`),
        redirects,
        finalUrl: current,
      };
    }

    const location = Array.isArray(result.headers.location)
      ? result.headers.location[0]
      : result.headers.location;

    let next;
    try {
      next = new URL(String(location), current).toString();
    } catch {
      return {
        ...failure(url, totalLatencyMs, `Redirect to an unusable location: ${String(location)}`),
        redirects,
        finalUrl: current,
      };
    }

    current = next;
    redirects += 1;
  }
}

/**
 * Probes many URLs with a bounded number in flight.
 *
 * Concurrency is bounded rather than unlimited because the target is usually
 * a single origin: firing two hundred parallel requests at it is a load test
 * that will be reported as an outage.
 *
 * @param {string[]} urls
 * @param {{
 *   concurrency?: number,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   followRedirects?: boolean,
 * }} [options]
 * @returns {Promise<ProbeResult[]>}
 */
async function probeAll(urls, options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  /** @type {ProbeResult[]} */
  const results = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) {
        return;
      }
      results[index] = await probe(urls[index], { ...options, captureBody: false });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

module.exports = {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  probe,
  probeAll,
  requestOnce,
};
