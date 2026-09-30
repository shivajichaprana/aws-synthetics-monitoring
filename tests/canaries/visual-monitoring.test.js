'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCanary, withEnv } = require('../support/runtime');
const { createPage } = require('../support/page');

/**
 * The visual canary is the one most likely to cry wolf, and the one whose
 * failures are hardest to read — a picture that differs, with no statement of
 * what was compared against what. So these tests concentrate on the identity of
 * the thing being captured: which URL, under which step name, at which
 * viewport, against which baseline.
 */

const TARGET = 'https://app.example.test/';

/**
 * @param {Record<string, string>} env
 * @param {Parameters<typeof createPage>[0]} [pageOptions]
 */
async function run(env, pageOptions = {}) {
  const page = createPage({ url: undefined, status: 200, ...pageOptions });
  const { module, runtime } = loadCanary('visual-monitoring.js', { page: page.page });

  try {
    const outcome = await withEnv({ TARGET_URL: TARGET, ...env }, () => module.handler());
    return { outcome, error: null, runtime, page };
  } catch (error) {
    return { outcome: null, error: /** @type {Error} */ (error), runtime, page };
  }
}

test('with no journey configured the landing page alone is captured', async () => {
  const { outcome, error, runtime, page } = await run({});

  assert.equal(error, null);
  assert.match(String(outcome), /1 view\(s\) captured/);
  assert.deepEqual(runtime.stepNames(), ['landing']);
  assert.equal(page.navigations[0].url, TARGET);
});

test('each journey step becomes its own named step and navigation', async () => {
  const journey = JSON.stringify([
    { name: 'landing', path: '/' },
    { name: 'pricing', path: '/pricing', waitFor: 'h1' },
    { name: 'docs', path: 'docs/intro' },
  ]);
  const { error, runtime, page } = await run({ JOURNEY_STEPS: journey });

  assert.equal(error, null);
  assert.deepEqual(runtime.stepNames(), ['landing', 'pricing', 'docs']);
  assert.deepEqual(
    page.navigations.map((navigation) => navigation.url),
    ['https://app.example.test/', 'https://app.example.test/pricing', 'https://app.example.test/docs/intro'],
  );
  assert.ok(page.waitedFor.includes('h1'));
});

test('a step whose path leaves the target origin is refused at startup', async () => {
  // `new URL(path, target)` is a resolver, not a joiner. A value beginning with
  // two slashes is read as a HOST, so "//pricing" becomes https://pricing/ —
  // and the canary would then screenshot a different site, store it as this
  // application's baseline, and report on it under this application's name.
  // One mistyped slash is the realistic way in.
  for (const path of ['//pricing', '//elsewhere.example.test/x', 'https://elsewhere.example.test/x', 'http://app.example.test/x']) {
    const { error } = await run({ JOURNEY_STEPS: JSON.stringify([{ name: 'step', path }]) });
    assert.equal(error && error.name, 'ConfigurationError', path);
    assert.match(String(error && error.message), /is not TARGET_URL's origin/, path);
  }
});

test('the refusal explains the two-slash reading rather than only naming the origin', async () => {
  const { error } = await run({ JOURNEY_STEPS: JSON.stringify([{ name: 'pricing', path: '//pricing' }]) });
  assert.match(String(error && error.message), /read as a host/);
  assert.match(String(error && error.message), /"\/pricing"/);
});

test('an ordinary relative path resolves against the target without complaint', async () => {
  const { error, page } = await run({
    TARGET_URL: 'https://app.example.test/app/',
    JOURNEY_STEPS: JSON.stringify([{ name: 'inner', path: 'settings' }, { name: 'root', path: '/' }]),
  });
  assert.equal(error, null);
  assert.deepEqual(
    page.navigations.map((navigation) => navigation.url),
    ['https://app.example.test/app/settings', 'https://app.example.test/'],
  );
});

test('a duplicate step name is refused, because names identify baselines', async () => {
  // Two different pages compared against one baseline would surface as a
  // flapping alarm rather than as a configuration error.
  const journey = JSON.stringify([
    { name: 'pricing', path: '/pricing' },
    { name: 'Pricing', path: '/plans' },
  ]);
  const { error } = await run({ JOURNEY_STEPS: journey });
  assert.match(String(error && error.message), /twice/);
});

test('a step name that cannot be a file name is refused', async () => {
  for (const name of ['', '   ', 'has space', 'slash/name', 'dot.name', '-leading']) {
    const { error } = await run({ JOURNEY_STEPS: JSON.stringify([{ name, path: '/' }]) });
    assert.equal(error && error.name, 'ConfigurationError', JSON.stringify(name));
  }
});

test('a journey that is not a non-empty array of objects is refused', async () => {
  for (const journey of ['[]', '{}', '"pricing"', '[null]', '[[1]]', '[{"path":"/"}]']) {
    const { error } = await run({ JOURNEY_STEPS: journey });
    assert.equal(error && error.name, 'ConfigurationError', journey);
  }
});

test('the baseline is compared by default and only replaced when asked', async () => {
  // A baseline that regenerates on every run compares the page to itself and
  // always passes, so the switch is off unless set and it says so loudly.
  const comparing = await run({});
  assert.equal(comparing.runtime.configuration.withVisualCompareWithBaseRun, true);
  assert.equal(comparing.runtime.configuration.withUpdateBaseRunImages, undefined);
  assert.match(String(comparing.outcome), /compared at 1% tolerance/);

  const regenerating = await run({ GENERATE_BASELINE: 'true' });
  assert.equal(regenerating.runtime.configuration.withUpdateBaseRunImages, true);
  assert.match(String(regenerating.outcome), /baseline regenerated/);
  assert.ok(regenerating.runtime.logs.some((entry) => entry.level === 'warn' && entry.message.includes('GENERATE_BASELINE')));
});

test('the variance tolerance is passed through and bounded', async () => {
  const set = await run({ VISUAL_VARIANCE_PCT: '3' });
  assert.equal(set.runtime.configuration.withVisualVarianceThresholdPercentage, 3);
  assert.match(String(set.outcome), /3% tolerance/);

  for (const value of ['-1', '101', 'some']) {
    const { error } = await run({ VISUAL_VARIANCE_PCT: value });
    assert.equal(error && error.name, 'ConfigurationError', value);
  }
});

test('the viewport is set before any navigation and is bounded', async () => {
  // Changing either dimension invalidates the baseline, so the value has to be
  // deliberate rather than whatever the runtime defaults to.
  const { page } = await run({ VIEWPORT_WIDTH: '1440', VIEWPORT_HEIGHT: '1000' });
  assert.deepEqual(page.viewports, [{ width: 1440, height: 1000 }]);

  for (const env of [{ VIEWPORT_WIDTH: '100' }, { VIEWPORT_HEIGHT: '10000' }]) {
    const { error } = await run(env);
    assert.equal(error && error.name, 'ConfigurationError', JSON.stringify(env));
  }
});

test('a visual check waits for the load event, not just the DOM', async () => {
  // The page is being judged on how it looks, which needs the stylesheets and
  // the fonts to have arrived.
  const { page } = await run({});
  assert.equal(page.navigations[0].options.waitUntil, 'load');
});

test('a redirect is acceptable but an error status is not', async () => {
  const redirected = await run({}, { status: 302 });
  assert.equal(redirected.error, null);

  const failed = await run({}, { status: 404 });
  assert.match(String(failed.error && failed.error.message), /received 404/);

  const nothing = await run({}, { status: null });
  assert.match(String(nothing.error && nothing.error.message), /produced no HTTP response/);
});

test('masking is reported and only attempted when selectors were given', async () => {
  const masked = await run({ IGNORE_SELECTORS: '.clock,.promo' }, { maskedCount: 4 });
  assert.equal(masked.error, null);
  assert.ok(masked.runtime.logged('Masked 4 element(s)'));

  const unmasked = await run({});
  assert.equal(unmasked.runtime.logs.some((entry) => entry.message.includes('Masked')), false);
});

test('a failing waitFor selector fails the step it belongs to', async () => {
  const { error, runtime } = await run(
    { JOURNEY_STEPS: JSON.stringify([{ name: 'pricing', path: '/pricing', waitFor: '.never' }]) },
    { selectorFails: true },
  );
  assert.match(String(error && error.message), /\.never/);
  assert.deepEqual(runtime.steps.map((step) => [step.name, step.ok]), [['pricing', false]]);
});

test('an artifact screenshot is taken per step, and full-page only on request', async () => {
  // The step wrapper's own capture is what the runtime compares; this second
  // one is the artifact a person opens when the comparison fails, and it is the
  // only place FULL_PAGE_SCREENSHOT has an effect — a full-page baseline would
  // differ whenever the page simply got longer.
  const { runtime } = await run({
    JOURNEY_STEPS: JSON.stringify([{ name: 'landing', path: '/' }, { name: 'pricing', path: '/pricing' }]),
    FULL_PAGE_SCREENSHOT: 'true',
  });

  assert.deepEqual(
    runtime.screenshots.map((shot) => [shot.name, shot.suffix, shot.options.fullPage]),
    [['landing', 'rendered', true], ['pricing', 'rendered', true]],
  );

  const defaulted = await run({});
  assert.equal(defaulted.runtime.screenshots[0].options.fullPage, false);
});

test('the settle pause is bounded and can be switched off', async () => {
  const off = await run({ SETTLE_MS: '0' });
  assert.equal(off.error, null);

  const tooLong = await run({ SETTLE_MS: '20000' });
  assert.equal(tooLong.error && tooLong.error.name, 'ConfigurationError');
});

test('the canary labels its own traffic in the user agent', async () => {
  const { page } = await run({});
  assert.match(page.userAgents[0], /synthetic-visual-check$/);
});

test('an unset or unusable target is refused before the browser is opened', async () => {
  const bare = loadCanary('visual-monitoring.js', { page: createPage().page });
  await assert.rejects(
    () => withEnv({}, () => bare.module.handler()),
    (/** @type {Error} */ error) => error.message.includes('TARGET_URL'),
  );
});
