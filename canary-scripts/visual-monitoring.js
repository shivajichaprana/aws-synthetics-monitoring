'use strict';

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const config = require('./lib/config');
const assertions = require('./lib/assertions');

/**
 * Visual-monitoring canary.
 *
 * Walks a short journey through the application and compares each screenshot
 * against a stored baseline, failing when the rendered page drifts beyond a
 * tolerance. This is the check for the failure mode every other canary here
 * is blind to: a page that answers 200, contains all its text, and renders as
 * a blank column because a stylesheet stopped being served.
 *
 * Visual comparison is the canary most likely to cry wolf, so three things
 * are built in rather than left to the operator to discover:
 *
 * A variance tolerance. Fonts hint differently and antialiasing is not
 * deterministic across runtime upgrades, so a strict pixel match fails on a
 * page nobody touched. The default tolerance absorbs that and nothing larger.
 *
 * Masking. Clocks, session identifiers, carousels and advert slots differ on
 * every load by design. `IGNORE_SELECTORS` hides them before the capture, so
 * they neither fail the run nor have to be tolerated by widening the
 * threshold until real regressions fit through it too.
 *
 * An explicit baseline switch. `GENERATE_BASELINE` is how a deliberate
 * redesign is accepted. It is a run-configuration change rather than a code
 * change, and it is off by default, because a baseline that regenerates
 * itself on every run compares the page to itself and always passes.
 *
 * Configuration:
 *
 *   TARGET_URL             required, where the journey starts
 *   JOURNEY_STEPS          JSON array of steps, see below; default is the landing page alone
 *   GENERATE_BASELINE      default false; true accepts the current rendering as the new baseline
 *   VISUAL_VARIANCE_PCT    default 1, the tolerated percentage of differing pixels
 *   IGNORE_SELECTORS       comma-separated CSS selectors hidden before capture
 *   VIEWPORT_WIDTH         default 1280
 *   VIEWPORT_HEIGHT        default 900
 *   FULL_PAGE_SCREENSHOT   default false
 *   PAGE_LOAD_TIMEOUT_MS   default 30000
 *   SETTLE_MS              default 500, a pause before capture for entry animations
 *
 * A journey step is `{ "name": "pricing", "path": "/pricing", "waitFor": "h1" }`.
 * `path` is resolved against TARGET_URL and must stay on its origin; `waitFor`
 * is an optional selector that must appear before the screenshot is taken.
 */

const USER_AGENT = 'synthetic-visual-check';

/** @typedef {{ name: string, path: string, url: string, waitFor: string | null }} JourneyStep */

/**
 * Resolves a step's path against the target and refuses one that leaves it.
 *
 * `new URL(path, target)` is a resolver, not a joiner, so it accepts a great
 * deal more than a path. A value beginning with two slashes is read as a host:
 * `//pricing` against `https://app.example.com/` resolves to `https://pricing/`,
 * and an absolute URL replaces the target outright. Either way the canary would
 * screenshot a different site, store it as this application's baseline, and
 * report on it under this application's name — while the run, the dashboard and
 * the alarm all still say the application is being watched.
 *
 * One mistyped slash is the realistic way in, which is why this is a refusal at
 * startup rather than a note in the documentation.
 *
 * @param {string} name the step's name, for the message
 * @param {string} path
 * @param {URL} base
 * @returns {string}
 */
function resolveStepUrl(name, path, base) {
  let resolved;
  try {
    resolved = new URL(path, base);
  } catch {
    throw new config.ConfigurationError(
      `JOURNEY_STEPS entry "${name}" has a path that cannot be resolved against TARGET_URL: "${path}".`,
    );
  }

  if (resolved.origin !== base.origin) {
    throw new config.ConfigurationError(
      `JOURNEY_STEPS entry "${name}" resolves to ${resolved.origin}, which is not TARGET_URL's origin ` +
        `(${base.origin}). A path starting with two slashes is read as a host rather than as a directory, ` +
        `so "//pricing" becomes https://pricing/ — write "/pricing" instead.`,
    );
  }

  return resolved.toString();
}

/**
 * Validates the journey definition.
 *
 * Step names become screenshot file names and therefore baseline identities,
 * so a duplicate name would silently compare two different pages against one
 * baseline. That is rejected here rather than discovered as a flapping alarm.
 *
 * @param {unknown} raw
 * @param {string} baseUrl the already-validated TARGET_URL
 * @returns {JourneyStep[]}
 */
function parseJourney(raw, baseUrl) {
  const base = new URL(baseUrl);

  if (raw === null || raw === undefined) {
    return [{ name: 'landing', path: '', url: base.toString(), waitFor: null }];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new config.ConfigurationError('JOURNEY_STEPS must be a non-empty JSON array of step objects.');
  }

  const seen = new Set();
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new config.ConfigurationError(`JOURNEY_STEPS entry ${index} is not an object.`);
    }
    const step = /** @type {Record<string, unknown>} */ (entry);
    const name = typeof step.name === 'string' ? step.name.trim() : '';
    if (name === '') {
      throw new config.ConfigurationError(`JOURNEY_STEPS entry ${index} has no name.`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      throw new config.ConfigurationError(
        `JOURNEY_STEPS entry "${name}" must be alphanumeric with hyphens; the name becomes a screenshot file name.`,
      );
    }
    if (seen.has(name.toLowerCase())) {
      throw new config.ConfigurationError(
        `JOURNEY_STEPS contains "${name}" twice. Step names identify baselines, so they have to be unique.`,
      );
    }
    seen.add(name.toLowerCase());

    const path = typeof step.path === 'string' ? step.path : '';

    return {
      name,
      path,
      url: resolveStepUrl(name, path, base),
      waitFor: typeof step.waitFor === 'string' && step.waitFor.trim() !== '' ? step.waitFor.trim() : null,
    };
  });
}

/**
 * @returns {{
 *   targetUrl: string,
 *   journey: JourneyStep[],
 *   generateBaseline: boolean,
 *   variancePct: number,
 *   ignoreSelectors: string[],
 *   viewportWidth: number,
 *   viewportHeight: number,
 *   fullPage: boolean,
 *   pageLoadTimeoutMs: number,
 *   settleMs: number,
 * }}
 */
function readConfiguration() {
  // Read into a local first: the journey's paths are resolved against it, and
  // the target has to be a validated absolute URL before that can happen.
  const targetUrl = config.requiredUrl('TARGET_URL');

  return {
    targetUrl,
    journey: parseJourney(config.json('JOURNEY_STEPS', { fallback: null }), targetUrl),
    generateBaseline: config.boolean('GENERATE_BASELINE', { fallback: false }),
    variancePct: config.integer('VISUAL_VARIANCE_PCT', { fallback: 1, min: 0, max: 100 }),
    ignoreSelectors: config.list('IGNORE_SELECTORS'),
    viewportWidth: config.integer('VIEWPORT_WIDTH', { fallback: 1280, min: 320, max: 3840 }),
    viewportHeight: config.integer('VIEWPORT_HEIGHT', { fallback: 900, min: 240, max: 2160 }),
    fullPage: config.boolean('FULL_PAGE_SCREENSHOT', { fallback: false }),
    pageLoadTimeoutMs: config.integer('PAGE_LOAD_TIMEOUT_MS', { fallback: 30000, min: 1000, max: 60000 }),
    settleMs: config.integer('SETTLE_MS', { fallback: 500, min: 0, max: 10000 }),
  };
}

/**
 * Hides the elements that legitimately differ between runs.
 *
 * `visibility: hidden` rather than `display: none`: the element keeps its
 * box, so hiding a clock does not reflow everything below it and turn a
 * masked region into a whole-page difference.
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} selectors
 * @returns {Promise<number>} how many elements were hidden
 */
async function maskDynamicRegions(page, selectors) {
  if (selectors.length === 0) {
    return 0;
  }
  return page.evaluate((list) => {
    let hidden = 0;
    for (const selector of list) {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch {
        // An invalid selector must not take the run down; it is reported by
        // the count coming back lower than expected.
        continue;
      }
      for (const element of matches) {
        element.style.visibility = 'hidden';
        hidden += 1;
      }
    }
    return hidden;
  }, selectors);
}

/**
 * @returns {Promise<string>}
 */
const visualMonitoring = async function () {
  const settings = readConfiguration();

  const configuration = synthetics.getConfiguration();
  configuration
    .withScreenshotOnStepStart(false)
    .withScreenshotOnStepSuccess(true)
    .withScreenshotOnStepFailure(true)
    .withVisualCompareWithBaseRun(true)
    .withVisualVarianceThresholdPercentage(settings.variancePct);

  if (settings.generateBaseline) {
    log.warn('GENERATE_BASELINE is on: this run replaces the stored baseline instead of comparing against it.');
    configuration.withUpdateBaseRunImages(true);
  }

  const page = await synthetics.getPage();
  await page.setViewport({ width: settings.viewportWidth, height: settings.viewportHeight });
  await page.setUserAgent(`${await page.browser().userAgent()} ${USER_AGENT}`);

  for (const step of settings.journey) {
    // Already resolved and origin-checked at startup, so the loop navigates to
    // a value that has been validated rather than re-deriving it per step.
    const url = step.url;

    await synthetics.executeStep(step.name, async function () {
      const response = await page.goto(url, {
        // A visual check needs the stylesheets and fonts, so this one waits
        // for the load event rather than for the DOM alone. The page is being
        // judged on how it looks.
        waitUntil: 'load',
        timeout: settings.pageLoadTimeoutMs,
      });

      const status = response === null ? null : response.status();
      if (status === null) {
        throw new assertions.AssertionFailure(`Loading ${url} produced no HTTP response.`, { url });
      }
      assertions.assertStatus(status, '2xx,3xx', { url });

      if (step.waitFor) {
        await page.waitForSelector(step.waitFor, { timeout: settings.pageLoadTimeoutMs });
      }

      const hidden = await maskDynamicRegions(page, settings.ignoreSelectors);
      if (settings.ignoreSelectors.length > 0) {
        log.info(`Masked ${hidden} element(s) matching IGNORE_SELECTORS before capture.`);
      }

      if (settings.settleMs > 0) {
        // Entry animations and lazily loaded images settle here. Without the
        // pause the capture races them and the same page differs from itself
        // between runs.
        await new Promise((resolve) => setTimeout(resolve, settings.settleMs));
      }

      // The screenshot taken by the step wrapper is the one the runtime
      // compares against the baseline. This second capture is the artifact a
      // person opens when the comparison fails, and it is the only place
      // FULL_PAGE_SCREENSHOT has an effect: a full-page baseline would differ
      // whenever the page simply got longer.
      await synthetics.takeScreenshot(step.name, 'rendered', { fullPage: settings.fullPage });
    });
  }

  const mode = settings.generateBaseline ? 'baseline regenerated' : `compared at ${settings.variancePct}% tolerance`;
  const outcome = `${settings.journey.length} view(s) captured from ${settings.targetUrl}, ${mode}.`;
  log.info(outcome);
  return outcome;
};

exports.handler = async () => visualMonitoring();
