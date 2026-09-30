'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCanary, withEnv } = require('../support/runtime');
const { createPage } = require('../support/page');

/**
 * The heartbeat is what an availability objective is measured against, so its
 * own cost is part of the measurement. Most of these tests are therefore about
 * what it does NOT do: no HAR file, no screenshot unless asked, and a
 * navigation that waits for the DOM rather than for the network to fall quiet.
 */

const TARGET = 'https://app.example.test/';

/**
 * @param {Record<string, string>} env
 * @param {Parameters<typeof createPage>[0]} [pageOptions]
 */
async function run(env, pageOptions = {}) {
  const page = createPage(pageOptions);
  const { module, runtime } = loadCanary('heartbeat-canary.js', { page: page.page });

  try {
    const outcome = await withEnv({ TARGET_URL: TARGET, ...env }, () => module.handler());
    return { outcome, error: null, runtime, page };
  } catch (error) {
    return { outcome: null, error: /** @type {Error} */ (error), runtime, page };
  }
}

test('a page that answers 200 passes and the step is named for the load', async () => {
  const { outcome, error, runtime } = await run({});

  assert.equal(error, null);
  assert.match(String(outcome), /answered 200/);
  // The latency alarm scopes the Duration metric to this step name. Renaming
  // it here would detach the alarm from the metric without any error.
  assert.deepEqual(runtime.stepNames(), ['load']);
});

test('the navigation waits for the DOM, not for the network to go quiet', async () => {
  // A page holding an analytics socket open never reaches networkidle0, and
  // waiting for it turns a healthy page into a timeout.
  const { page } = await run({});
  assert.equal(page.navigations[0].options.waitUntil, 'domcontentloaded');
  assert.equal(page.navigations[0].options.timeout, 10000);
  assert.equal(page.navigations[0].url, TARGET);
});

test('an alternative wait state is accepted and an invented one is refused', async () => {
  const accepted = await run({ WAIT_UNTIL: 'LOAD' });
  assert.equal(accepted.error, null);
  assert.equal(accepted.page.navigations[0].options.waitUntil, 'load');

  const refused = await run({ WAIT_UNTIL: 'networkidle' });
  assert.match(String(refused.error && refused.error.message), /WAIT_UNTIL must be one of/);
});

test('the default expectation is any 2xx, and a 500 fails', async () => {
  const redirected = await run({}, { status: 204 });
  assert.equal(redirected.error, null);

  const failed = await run({}, { status: 500 });
  assert.match(String(failed.error && failed.error.message), /received 500/);
});

test('a navigation with no HTTP response at all is a failure', async () => {
  // A null response means the navigation resolved without an exchange the
  // browser attributed to it, which for a top-level page load is a failure
  // however the page happens to look.
  const { error } = await run({}, { status: null });
  assert.match(String(error && error.message), /produced no HTTP response/);
});

test('the latency budget is off by default and enforced when set', async () => {
  const slow = { navigationDelayMs: 120 };

  const off = await run({}, slow);
  assert.equal(off.error, null, 'no budget means no latency check, however slow the page');

  const within = await run({ LATENCY_BUDGET_MS: '5000' }, slow);
  assert.equal(within.error, null, 'a page inside its budget passes');

  const over = await run({ LATENCY_BUDGET_MS: '20' }, slow);
  assert.match(String(over.error && over.error.message), /20 ms budget/);
});

test('a page-load timeout outside its bounds is refused', async () => {
  for (const value of ['500', '600000', 'soon']) {
    const { error } = await run({ PAGE_LOAD_TIMEOUT_MS: value });
    assert.ok(error, value);
    assert.equal(error && error.name, 'ConfigurationError', value);
  }
});

test('BODY_MUST_CONTAIN is checked against rendered text, in its own step', async () => {
  // Rendered text rather than the response source: the question is whether a
  // person would see it, and a marker hidden in a script tag does not qualify.
  const present = await run({ BODY_MUST_CONTAIN: 'All systems' }, { text: 'All systems operational' });
  assert.equal(present.error, null);
  assert.deepEqual(present.runtime.stepNames(), ['load', 'content']);

  const absent = await run({ BODY_MUST_CONTAIN: 'All systems' }, { text: 'Scheduled maintenance' });
  assert.match(String(absent.error && absent.error.message), /All systems/);
  assert.deepEqual(absent.runtime.stepNames(), ['load', 'content']);
});

test('the content step is skipped entirely when nothing was asked for', async () => {
  const { runtime } = await run({});
  assert.deepEqual(runtime.stepNames(), ['load']);
});

test('no HAR file is written and successes are not captured by default', async () => {
  const { runtime } = await run({});
  assert.equal(runtime.configuration.withHarFile, false);
  assert.equal(runtime.configuration.withScreenshotOnStepStart, false);
  assert.equal(runtime.configuration.withScreenshotOnStepSuccess, false);
  // A failure screenshot is worth its cost even when successes are not: it is
  // the difference between "the page did not load" and a picture of the error
  // the origin rendered.
  assert.equal(runtime.configuration.withScreenshotOnStepFailure, true);
});

test('a success screenshot can be turned on without turning off the failure one', async () => {
  const { runtime } = await run({ TAKE_SCREENSHOT: 'true' });
  assert.equal(runtime.configuration.withScreenshotOnStepSuccess, true);
  assert.equal(runtime.configuration.withScreenshotOnStepFailure, true);
});

test('the canary labels its own traffic in the user agent', async () => {
  const { page } = await run({});
  assert.equal(page.userAgents.length, 1);
  assert.match(page.userAgents[0], /synthetic-heartbeat$/);
  assert.match(page.userAgents[0], /HeadlessChrome/, 'the real agent is kept, not replaced');
});

test('an unset or unusable target is refused before the browser is opened', async () => {
  const bare = loadCanary('heartbeat-canary.js', { page: createPage().page });
  await assert.rejects(
    () => withEnv({}, () => bare.module.handler()),
    (/** @type {Error} */ error) => error.message.includes('TARGET_URL'),
  );

  const relative = loadCanary('heartbeat-canary.js', { page: createPage().page });
  await assert.rejects(
    () => withEnv({ TARGET_URL: '/health' }, () => relative.module.handler()),
    (/** @type {Error} */ error) => error.name === 'ConfigurationError',
  );
});
