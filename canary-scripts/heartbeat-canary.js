'use strict';

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const config = require('./lib/config');
const assertions = require('./lib/assertions');

/**
 * Heartbeat canary.
 *
 * Loads one page at the fastest cadence the service allows and answers a
 * single question: is it up. Everything that could make the run slower is
 * either off or optional, because this canary is what an availability
 * objective is measured against and its own latency becomes part of the
 * measurement.
 *
 * Concretely, that means no screenshot unless asked for, no HAR file, and a
 * navigation that waits for the DOM rather than for the network to fall
 * quiet — a page with an open analytics socket never reaches `networkidle0`,
 * and waiting for it turns a healthy page into a timeout.
 *
 * Configuration:
 *
 *   TARGET_URL               required, the page to load
 *   EXPECTED_STATUS          default 2xx
 *   PAGE_LOAD_TIMEOUT_MS     default 10000
 *   LATENCY_BUDGET_MS        default 0 (off)
 *   BODY_MUST_CONTAIN        text that must be present once the DOM is ready
 *   TAKE_SCREENSHOT          default false
 *   WAIT_UNTIL               default domcontentloaded
 */

const ALLOWED_WAIT_STATES = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'];

const USER_AGENT = 'synthetic-heartbeat';

/**
 * @returns {{
 *   targetUrl: string,
 *   expectedStatus: string,
 *   pageLoadTimeoutMs: number,
 *   latencyBudgetMs: number,
 *   bodyMustContain: string | null,
 *   takeScreenshot: boolean,
 *   waitUntil: string,
 * }}
 */
function readConfiguration() {
  const waitUntil = (config.optionalString('WAIT_UNTIL', 'domcontentloaded') ?? 'domcontentloaded').toLowerCase();
  if (!ALLOWED_WAIT_STATES.includes(waitUntil)) {
    throw new config.ConfigurationError(
      `WAIT_UNTIL must be one of ${ALLOWED_WAIT_STATES.join(', ')} but was ${waitUntil}.`,
    );
  }

  return {
    targetUrl: config.requiredUrl('TARGET_URL'),
    expectedStatus: config.optionalString('EXPECTED_STATUS', '2xx') ?? '2xx',
    pageLoadTimeoutMs: config.integer('PAGE_LOAD_TIMEOUT_MS', { fallback: 10000, min: 1000, max: 60000 }),
    latencyBudgetMs: config.integer('LATENCY_BUDGET_MS', { fallback: 0, min: 0 }),
    bodyMustContain: config.optionalString('BODY_MUST_CONTAIN'),
    takeScreenshot: config.boolean('TAKE_SCREENSHOT', { fallback: false }),
    waitUntil,
  };
}

/**
 * @returns {Promise<string>}
 */
const heartbeatCanary = async function () {
  const settings = readConfiguration();

  synthetics
    .getConfiguration()
    .withScreenshotOnStepStart(false)
    .withScreenshotOnStepSuccess(settings.takeScreenshot)
    // A failure screenshot is worth its cost even when successes are not: it
    // is the difference between "the page did not load" and a picture of the
    // error the origin rendered.
    .withScreenshotOnStepFailure(true)
    .withHarFile(false);

  const page = await synthetics.getPage();
  await page.setUserAgent(`${await page.browser().userAgent()} ${USER_AGENT}`);

  /** @type {number} */
  let latencyMs = 0;
  /** @type {number} */
  let status = 0;

  await synthetics.executeStep('load', async function () {
    const startedAt = process.hrtime.bigint();
    const response = await page.goto(settings.targetUrl, {
      waitUntil: settings.waitUntil,
      timeout: settings.pageLoadTimeoutMs,
    });
    latencyMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);

    if (response === null) {
      // A null response means the navigation resolved without an HTTP
      // exchange the browser attributed to it, which for a top-level page
      // load is a failure however the page happens to look.
      throw new assertions.AssertionFailure(
        `Loading ${settings.targetUrl} produced no HTTP response after ${latencyMs} ms.`,
        { url: settings.targetUrl },
      );
    }

    status = response.status();
    assertions.assertStatus(status, settings.expectedStatus, { url: settings.targetUrl, latencyMs });
    assertions.assertLatencyWithin(latencyMs, settings.latencyBudgetMs, { url: settings.targetUrl });
  });

  if (settings.bodyMustContain) {
    await synthetics.executeStep('content', async function () {
      // `document.body.innerText` rather than the raw response body: the
      // question this check answers is whether a person would see the text,
      // and a marker hidden in a script tag does not qualify.
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      assertions.assertBodyContains(text, /** @type {string} */ (settings.bodyMustContain), {
        url: settings.targetUrl,
      });
    });
  }

  const outcome = `${settings.targetUrl} answered ${status} in ${latencyMs} ms.`;
  log.info(outcome);
  return outcome;
};

exports.handler = async () => heartbeatCanary();
