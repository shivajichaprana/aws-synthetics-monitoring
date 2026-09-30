'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../canary-scripts/lib/probe');
const { startServer } = require('../support/server');

/**
 * The probe's whole reason for existing is that a failure must be recorded and
 * the run must carry on. A step-based helper fails the run on the first bad
 * link, so a page with twelve broken links reports one and the next run
 * reports the next one.
 *
 * That property only holds if nothing in here can reject or throw, whatever it
 * is pointed at — so most of these tests are about the shapes that would
 * ordinarily raise: a scheme no client supports, a server that never answers,
 * a redirect to nowhere. Each has to come back as a resolved result carrying an
 * error string.
 */

test('a successful request reports the status, the body and a latency', async () => {
  const server = await startServer({
    '/health': { status: 200, body: '{"status":"ok"}', headers: { 'content-type': 'application/json' } },
  });
  try {
    const result = await probe.probe(`${server.origin}/health`);
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"status":"ok"}');
    assert.equal(result.error, null);
    assert.equal(result.redirects, 0);
    assert.equal(typeof result.latencyMs, 'number');
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.headers['content-type'], 'application/json');
  } finally {
    await server.close();
  }
});

test('an unusable URL resolves with an error instead of rejecting', async () => {
  // `http.request` throws synchronously on an unsupported protocol. A throw
  // here would reject the promise and take the whole batch down over one
  // unusable href, which is the exact failure this probe exists to avoid.
  const unparseable = await probe.probe('not-a-url');
  assert.equal(unparseable.status, null);
  assert.match(String(unparseable.error), /is not a valid URL/);
  assert.equal(unparseable.url, 'not-a-url');

  // The scheme is checked before a client is chosen, and the message is
  // asserted rather than merely the presence of one: the client would also
  // refuse these, with its own wording, so a test satisfied by any error at all
  // would pass with the check deleted.
  for (const url of ['ftp://files.example.test/x', 'mailto:a@example.test', 'ws://app.example.test/socket']) {
    const result = await probe.probe(url);
    assert.equal(result.status, null, url);
    assert.match(String(result.error), /is not an HTTP scheme/, url);
    assert.equal(result.url, url);
  }
});

test('a server that never answers is cut off at the timeout', async () => {
  // A socket held open without a byte written is the condition the timeout
  // covers; without destroying it explicitly the canary would run until the
  // service-side run timeout killed it, and the run would report a timeout
  // rather than a slow endpoint.
  const server = await startServer({ '/hang': { neverRespond: true } });
  try {
    const started = Date.now();
    const result = await probe.probe(`${server.origin}/hang`, { timeoutMs: 300 });
    assert.equal(result.status, null);
    assert.match(String(result.error), /300 ms/);
    assert.ok(Date.now() - started < 5000, 'the timeout has to be the thing that ends the request');
  } finally {
    await server.close();
  }
});

test('a connection that cannot be made is an error, not a rejection', async () => {
  // Port 1 on loopback refuses immediately on every platform the runtime
  // ships on.
  const result = await probe.probe('http://127.0.0.1:1/', { timeoutMs: 2000 });
  assert.equal(result.status, null);
  assert.ok(result.error);
});

test('redirects are followed to the final address when asked for', async () => {
  const server = await startServer({
    '/one': { status: 302, headers: { location: '/two' } },
    '/two': { status: 301, headers: { location: '/three' } },
    '/three': { status: 200, body: 'arrived' },
  });
  try {
    const result = await probe.probe(`${server.origin}/one`);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'arrived');
    assert.equal(result.redirects, 2);
    assert.equal(result.finalUrl, `${server.origin}/three`);
    // The address asked for is preserved alongside the one reached, so a
    // report can name the link as it appears on the page.
    assert.equal(result.url, `${server.origin}/one`);
  } finally {
    await server.close();
  }
});

test('a relative redirect location is resolved against the hop it came from', async () => {
  const server = await startServer({
    '/a/b': { status: 302, headers: { location: 'c' } },
    '/a/c': { status: 200, body: 'relative' },
  });
  try {
    const result = await probe.probe(`${server.origin}/a/b`);
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, `${server.origin}/a/c`);
  } finally {
    await server.close();
  }
});

test('a redirect is returned as-is when redirects are not followed', async () => {
  // This is what lets the link checker tell a redirect from a success. A link
  // answering 301 works, but a navigation whose links all redirect is one
  // rename away from being broken.
  const server = await startServer({
    '/old': { status: 301, headers: { location: '/new' } },
    '/new': { status: 200, body: 'new' },
  });
  try {
    const result = await probe.probe(`${server.origin}/old`, { followRedirects: false });
    assert.equal(result.status, 301);
    assert.equal(result.redirects, 0);
  } finally {
    await server.close();
  }
});

test('a redirect loop is bounded and names the hop it gave up on', async () => {
  const server = await startServer({ '*': { status: 302, headers: { location: '/next' } } });
  try {
    const result = await probe.probe(`${server.origin}/start`, { maxRedirects: 3 });
    assert.equal(result.status, null);
    assert.match(String(result.error), /More than 3 redirects/);
    assert.equal(result.redirects, 3);
    assert.ok(String(result.finalUrl).startsWith(server.origin));
  } finally {
    await server.close();
  }
});

test('a redirect to an unusable location ends the walk with an error', async () => {
  const server = await startServer({ '/bad': { status: 302, headers: { location: 'http://' } } });
  try {
    const result = await probe.probe(`${server.origin}/bad`);
    assert.equal(result.status, null);
    assert.match(String(result.error), /unusable location/);
  } finally {
    await server.close();
  }
});

test('the method, headers and body reach the server as given', async () => {
  const server = await startServer({ '/echo': { status: 201, body: 'created' } });
  try {
    const result = await probe.probe(`${server.origin}/echo`, {
      method: 'post',
      headers: { 'content-type': 'application/json', 'x-check': 'yes' },
      body: '{"a":1}',
    });
    assert.equal(result.status, 201);
    assert.equal(server.received.length, 1);
    assert.equal(server.received[0].method, 'POST', 'the method is upper-cased before it is sent');
    assert.equal(server.received[0].headers['x-check'], 'yes');
    assert.equal(server.received[0].body, '{"a":1}');
  } finally {
    await server.close();
  }
});

test('a body larger than the cap is truncated rather than buffered whole', async () => {
  const server = await startServer({
    '/big': { status: 200, body: 'x'.repeat(probe.MAX_BODY_BYTES + 5000) },
  });
  try {
    const result = await probe.probe(`${server.origin}/big`);
    assert.equal(result.status, 200);
    assert.equal(result.body.length, probe.MAX_BODY_BYTES);
  } finally {
    await server.close();
  }
});

test('a query string survives the request', async () => {
  const server = await startServer({ '/search': { status: 200, body: 'ok' } });
  try {
    await probe.probe(`${server.origin}/search?q=a%20b&n=2`);
    assert.equal(server.received[0].url, '/search?q=a%20b&n=2');
  } finally {
    await server.close();
  }
});

test('probeAll returns one result per URL, in the order it was given', async () => {
  const server = await startServer({
    '/a': { status: 200 },
    '/b': { status: 404 },
    '/c': { status: 301, headers: { location: '/a' } },
  });
  try {
    const urls = [`${server.origin}/a`, `${server.origin}/b`, `${server.origin}/c`, 'not-a-url'];
    const results = await probe.probeAll(urls, { concurrency: 2, followRedirects: false });

    assert.equal(results.length, 4);
    // Position matters: the caller pairs each result with the link it came
    // from, so a reordered array would attribute a failure to the wrong URL.
    assert.deepEqual(
      results.map((result) => result.url),
      urls,
    );
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 404, 301, null],
    );
  } finally {
    await server.close();
  }
});

/**
 * Runs a batch and reports the greatest number of requests the server ever had
 * open at once.
 *
 * The count has to be bracketed by the server — incremented when a request
 * arrives and decremented when its response has finished — because counting
 * arrivals alone measures the size of the batch. A peak of 12 for a batch of 12
 * would then be reported for any bound whatsoever, and the assertion would be
 * satisfied by code that ignored the setting entirely.
 *
 * @param {number} concurrency
 * @param {number} count
 * @returns {Promise<number>}
 */
async function observedPeakConcurrency(concurrency, count) {
  let inFlight = 0;
  let peak = 0;
  const server = await startServer(
    { '*': { status: 200, delayMs: 40 } },
    {
      onRequestStart: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      },
      onRequestEnd: () => {
        inFlight -= 1;
      },
    },
  );

  try {
    const urls = Array.from({ length: count }, (_unused, index) => `${server.origin}/link-${index}`);
    const results = await probe.probeAll(urls, { concurrency });
    assert.equal(results.length, count);
    return peak;
  } finally {
    await server.close();
  }
}

test('probeAll never runs more requests at once than it was allowed', async () => {
  // The target is usually a single origin, so an uncapped burst at a
  // five-minute cadence is a load test that will be reported as an outage.
  const peak = await observedPeakConcurrency(3, 12);
  assert.ok(peak <= 3, `at most 3 requests should overlap, saw ${peak}`);
  assert.ok(peak > 1, 'the work should still actually be done in parallel');
});

test('the concurrency measurement can see a burst it is not supposed to allow', async () => {
  // Calibration for the test above. Without this, a measurement that always
  // answered 1 would satisfy the bound and prove nothing.
  const peak = await observedPeakConcurrency(8, 16);
  assert.ok(peak > 3, `a bound of 8 should be visible as overlap above 3, saw ${peak}`);
  assert.ok(peak <= 8, `and still no higher than the bound, saw ${peak}`);
});

test('probeAll on an empty list does nothing and returns nothing', async () => {
  const results = await probe.probeAll([]);
  assert.deepEqual(results, []);
});

test('probeAll does not buffer bodies it will never read', async () => {
  // A link check asserts on status codes only. Holding every page it visits in
  // memory would be a 960 MB function reading a 40 MB download for nothing.
  const server = await startServer({ '/page': { status: 200, body: 'x'.repeat(4096) } });
  try {
    const [result] = await probe.probeAll([`${server.origin}/page`]);
    assert.equal(result.status, 200);
    assert.equal(result.body, '');
  } finally {
    await server.close();
  }
});

test('a concurrency below one is raised to one rather than stalling', async () => {
  const server = await startServer({ '/a': { status: 200 } });
  try {
    const results = await probe.probeAll([`${server.origin}/a`], { concurrency: 0 });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 200);
  } finally {
    await server.close();
  }
});
