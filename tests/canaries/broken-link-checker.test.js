'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCanary, withEnv } = require('../support/runtime');
const { createPage } = require('../support/page');
const { startServer } = require('../support/server');

/**
 * The link checker is the one canary here that must complete its work before
 * it fails. A step-based helper aborts on the first bad link, so a page with
 * twelve broken links reports one and the next run reports the next one; the
 * run artifact is then worth nothing to whoever opens it.
 *
 * These tests run the real script against a real local server, so the probing,
 * the capping and the summary are all genuinely executed.
 */

/**
 * @param {Record<string, string>} env
 * @param {{ hrefs?: Array<string | null>, status?: number | null, url?: string }} pageOptions
 * @param {Record<string, any>} routes
 */
async function run(env, pageOptions, routes) {
  const server = await startServer(routes);
  const page = createPage({ url: `${server.origin}/`, status: 200, ...pageOptions });
  const { module, runtime } = loadCanary('broken-link-checker.js', { page: page.page });

  try {
    const outcome = await withEnv(
      { TARGET_URL: `${server.origin}/`, LINK_TIMEOUT_MS: '2000', ...env },
      () => module.handler(),
    );
    return { outcome, error: null, runtime, page, server };
  } catch (error) {
    return { outcome: null, error: /** @type {Error} */ (error), runtime, page, server };
  } finally {
    await server.close();
  }
}

const ROUTES = {
  '/': { status: 200, body: 'home' },
  '/good': { status: 200, body: 'good' },
  '/also-good': { status: 200, body: 'good' },
  '/moved': { status: 301, headers: { location: '/good' } },
  '/gone': { status: 404, body: 'gone' },
  '/broken': { status: 500, body: 'boom' },
};

test('every link is checked before the run fails, and the failure names them all', async () => {
  const { error, outcome, runtime } = await run(
    {},
    { hrefs: ['/good', '/gone', '/also-good', '/broken'] },
    ROUTES,
  );

  assert.equal(outcome, null);
  const message = String(error && error.message);
  assert.match(message, /4 links checked: 2 ok, 0 redirected, 2 broken\./);
  // Both broken links are in the one failure, which is the property that makes
  // the run artifact useful rather than a drip feed across four runs.
  assert.match(message, /\/gone/);
  assert.match(message, /\/broken/);
  assert.deepEqual(runtime.stepNames(), ['collect', 'check']);
});

test('a redirect is reported in its own column rather than as a failure', async () => {
  const { error, outcome } = await run({}, { hrefs: ['/good', '/moved'] }, ROUTES);
  assert.equal(error, null);
  assert.match(String(outcome), /2 links checked: 1 ok, 1 redirected, 0 broken\./);
});

test('a clean page returns the summary instead of throwing', async () => {
  const { error, outcome } = await run({}, { hrefs: ['/good', '/also-good'] }, ROUTES);
  assert.equal(error, null);
  assert.match(String(outcome), /2 ok, 0 redirected, 0 broken/);
});

test('FAIL_ON_BROKEN reports without alarming', async () => {
  const { error, outcome } = await run({ FAIL_ON_BROKEN: 'false' }, { hrefs: ['/gone'] }, ROUTES);
  assert.equal(error, null);
  assert.match(String(outcome), /1 broken/);
});

test('the run log names each reason an href was not checked', async () => {
  // Reporting them as one total called "out of scope" sends whoever reads the
  // run off to audit a scoping configuration that is working as written.
  const { runtime } = await run(
    { SAME_ORIGIN_ONLY: 'true' },
    {
      hrefs: ['mailto:a@example.test', '#top', '/good', 'https://elsewhere.example.test/x', '/good'],
    },
    ROUTES,
  );

  const line = runtime.logs.map((entry) => entry.message).find((message) => message.includes('anchors on'));
  assert.ok(line, 'the collect step logs what it found');
  // Three hrefs resolved to a fetchable address — the two same-origin ones and
  // the external one, which is resolvable and then out of scope.
  assert.match(String(line), /3 resolvable/);
  assert.match(String(line), /2 not fetchable addresses/);
  assert.match(String(line), /1 out of scope/);
  assert.match(String(line), /1 repeated/);
  assert.match(String(line), /1 queued for checking/);
});

test('scoping is done against the address the page landed on, not the one configured', async () => {
  // Using the configured URL instead would classify same-origin links as
  // external whenever the target redirects to a canonical host.
  const server = await startServer(ROUTES);
  const page = createPage({ url: `${server.origin}/canonical/`, status: 200, hrefs: ['good', '/gone'] });
  const { module } = loadCanary('broken-link-checker.js', { page: page.page });

  try {
    await withEnv(
      { TARGET_URL: `${server.origin}/`, SAME_ORIGIN_ONLY: 'true', FAIL_ON_BROKEN: 'false', LINK_TIMEOUT_MS: '2000' },
      () => module.handler(),
    );
    // "good" is relative, so it resolves under /canonical/ — the page's own
    // address — and is a 404 rather than the /good route.
    assert.ok(server.received.some((request) => request.url === '/canonical/good'));
  } finally {
    await server.close();
  }
});

test('an unhealthy page is reported as itself, not as a page of broken links', async () => {
  const { error, runtime } = await run({}, { hrefs: ['/good'], status: 503 }, ROUTES);
  assert.match(String(error && error.message), /is itself unhealthy/);
  // The check step never runs: there is nothing to say about links on a page
  // that did not load.
  assert.deepEqual(runtime.stepNames(), ['collect']);
});

test('a page with no links in scope says so rather than passing silently', async () => {
  const { error, outcome, runtime } = await run(
    { SAME_ORIGIN_ONLY: 'true' },
    { hrefs: ['mailto:a@example.test', 'https://elsewhere.example.test/x'] },
    ROUTES,
  );
  assert.equal(error, null);
  assert.match(String(outcome), /nothing to check/);
  // A run that checked nothing and a run that found nothing broken produce the
  // same green square, so the distinction has to be in the outcome text.
  assert.deepEqual(runtime.stepNames(), ['collect']);
});

test('MAX_LINKS caps the work and the cap is stated in the outcome', async () => {
  const { error, outcome, runtime } = await run(
    { MAX_LINKS: '2' },
    { hrefs: ['/good', '/also-good', '/gone', '/broken'] },
    ROUTES,
  );

  assert.equal(error, null, 'the broken links were beyond the cap and not reached');
  assert.match(String(outcome), /2 links checked/);
  assert.match(String(outcome), /capped at 2/);
  assert.ok(runtime.logs.some((entry) => entry.level === 'warn' && entry.message.includes('MAX_LINKS')));
});

test('INCLUDE_PATTERNS and EXCLUDE_PATTERNS select what is checked', async () => {
  const included = await run(
    { INCLUDE_PATTERNS: '/good', FAIL_ON_BROKEN: 'false' },
    { hrefs: ['/good', '/gone', '/broken'] },
    ROUTES,
  );
  assert.match(String(included.outcome), /1 links checked: 1 ok/);

  const excluded = await run(
    { EXCLUDE_PATTERNS: '/gone,/broken' },
    { hrefs: ['/good', '/gone', '/broken'] },
    ROUTES,
  );
  assert.match(String(excluded.outcome), /1 links checked: 1 ok/);
});

test('links are requested with GET and a labelled user agent', async () => {
  // Enough origins answer 405 to a HEAD they serve happily as a GET that the
  // halved traffic is not worth the false findings.
  const { server } = await run({}, { hrefs: ['/good'] }, ROUTES);
  const linkRequest = server.received.find((request) => request.url === '/good');
  assert.ok(linkRequest);
  assert.equal(linkRequest.method, 'GET');
  assert.equal(linkRequest.headers['user-agent'], 'synthetic-link-check');
});

test('a link that never answers is broken rather than fatal to the run', async () => {
  const { error } = await run(
    { LINK_TIMEOUT_MS: '1000' },
    { hrefs: ['/good', '/hang'] },
    { ...ROUTES, '/hang': { neverRespond: true } },
  );
  const message = String(error && error.message);
  assert.match(message, /2 links checked: 1 ok, 0 redirected, 1 broken\./);
  assert.match(message, /1000 ms/);
});

test('each outcome is logged at a level that matches what it means', async () => {
  const { runtime } = await run(
    { FAIL_ON_BROKEN: 'false' },
    { hrefs: ['/good', '/moved', '/gone'] },
    ROUTES,
  );

  assert.ok(runtime.logs.some((entry) => entry.level === 'info' && entry.message.startsWith('OK ')));
  assert.ok(runtime.logs.some((entry) => entry.level === 'warn' && entry.message.startsWith('REDIRECT ')));
  assert.ok(runtime.logs.some((entry) => entry.level === 'error' && entry.message.startsWith('BROKEN ')));
});

test('the link selector is configurable and is what the page is queried with', async () => {
  const { page } = await run({ LINK_SELECTOR: 'main a[href]' }, { hrefs: ['/good'] }, ROUTES);
  assert.ok(page.waitedFor.includes('$$eval:main a[href]'));
});

test('a concurrency or cap outside its bounds is refused', async () => {
  for (const env of [{ CONCURRENCY: '0' }, { CONCURRENCY: '50' }, { MAX_LINKS: '5000' }, { MAX_LINKS: 'lots' }]) {
    const { error } = await run(env, { hrefs: ['/good'] }, ROUTES);
    assert.equal(error && error.name, 'ConfigurationError', JSON.stringify(env));
  }
});
