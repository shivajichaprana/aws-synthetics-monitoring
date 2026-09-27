'use strict';

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const config = require('./lib/config');
const links = require('./lib/links');
const probe = require('./lib/probe');

/**
 * Broken-link canary.
 *
 * Loads a page, collects the links a visitor could follow from it, and checks
 * each one. It is the check that catches the slow rot a status-code monitor
 * never sees: a renamed docs page, a retired pricing anchor, a partner whose
 * domain lapsed.
 *
 * Three decisions shape the implementation:
 *
 * Every link is checked before anything fails. A step-based helper aborts the
 * run on the first bad link, so a page with twelve broken links reports one,
 * and the next run reports the next one. The probe here records each outcome
 * and the run fails once, at the end, with the whole list — which is what
 * makes the run artifact worth opening.
 *
 * Requests are capped and bounded. The target is usually a single origin, so
 * an uncapped crawl at a five-minute cadence is a load test that will be
 * reported as an outage. `MAX_LINKS` bounds the work and `CONCURRENCY` bounds
 * the burst.
 *
 * Redirects are not followed and not failures. A link that answers 301 is
 * working, but a navigation whose links all redirect is one rename away from
 * being broken, so redirects are counted and reported separately rather than
 * folded into the success column.
 *
 * Configuration:
 *
 *   TARGET_URL            required, the page whose links are checked
 *   LINK_SELECTOR         default "a[href]"
 *   MAX_LINKS             default 50, 0 means no cap
 *   CONCURRENCY           default 4
 *   LINK_TIMEOUT_MS       default 10000
 *   SAME_ORIGIN_ONLY      default false
 *   INCLUDE_PATTERNS      comma-separated substrings; when set, only matches are checked
 *   EXCLUDE_PATTERNS      comma-separated substrings that are never checked
 *   PAGE_LOAD_TIMEOUT_MS  default 30000
 *   FAIL_ON_BROKEN        default true
 */

const USER_AGENT = 'synthetic-link-check';

/**
 * @returns {{
 *   targetUrl: string,
 *   linkSelector: string,
 *   maxLinks: number,
 *   concurrency: number,
 *   linkTimeoutMs: number,
 *   sameOriginOnly: boolean,
 *   includePatterns: string[],
 *   excludePatterns: string[],
 *   pageLoadTimeoutMs: number,
 *   failOnBroken: boolean,
 * }}
 */
function readConfiguration() {
  return {
    targetUrl: config.requiredUrl('TARGET_URL'),
    linkSelector: config.optionalString('LINK_SELECTOR', 'a[href]') ?? 'a[href]',
    maxLinks: config.integer('MAX_LINKS', { fallback: 50, min: 0, max: 1000 }),
    concurrency: config.integer('CONCURRENCY', { fallback: 4, min: 1, max: 20 }),
    linkTimeoutMs: config.integer('LINK_TIMEOUT_MS', { fallback: 10000, min: 1000, max: 60000 }),
    sameOriginOnly: config.boolean('SAME_ORIGIN_ONLY', { fallback: false }),
    includePatterns: config.list('INCLUDE_PATTERNS'),
    excludePatterns: config.list('EXCLUDE_PATTERNS'),
    pageLoadTimeoutMs: config.integer('PAGE_LOAD_TIMEOUT_MS', { fallback: 30000, min: 1000, max: 60000 }),
    failOnBroken: config.boolean('FAIL_ON_BROKEN', { fallback: true }),
  };
}

/**
 * @returns {Promise<string>}
 */
const brokenLinkChecker = async function () {
  const settings = readConfiguration();

  synthetics
    .getConfiguration()
    .withScreenshotOnStepStart(false)
    .withScreenshotOnStepSuccess(false)
    .withScreenshotOnStepFailure(true);

  const page = await synthetics.getPage();

  /** @type {string[]} */
  let selected = [];
  /** @type {{ considered: number, skipped: number, truncated: boolean }} */
  let selection = { considered: 0, skipped: 0, truncated: false };

  await synthetics.executeStep('collect', async function () {
    const response = await page.goto(settings.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: settings.pageLoadTimeoutMs,
    });

    const status = response === null ? null : response.status();
    if (status === null || status >= 400) {
      throw new Error(
        `The page whose links are being checked is itself unhealthy: ${settings.targetUrl} answered ${status ?? 'no response'}.`,
      );
    }

    // The href property, not the attribute: the browser has already resolved
    // it against the page's base URL, including any <base> tag, which is
    // exactly the resolution a visitor's click would get.
    const hrefs = await page.$$eval(settings.linkSelector, (elements) =>
      elements.map((element) => element.href ?? element.getAttribute('href')),
    );

    // The page's own address, after redirects, is the base for scoping. Using
    // the configured URL instead would classify same-origin links as external
    // whenever the target redirects to a canonical host.
    const baseUrl = page.url();

    const result = links.selectLinks(hrefs, {
      baseUrl,
      sameOriginOnly: settings.sameOriginOnly,
      includePatterns: settings.includePatterns,
      excludePatterns: settings.excludePatterns,
      limit: settings.maxLinks,
    });

    selected = result.links;
    selection = { considered: result.considered, skipped: result.skipped, truncated: result.truncated };

    log.info(
      `Found ${hrefs.length} anchors on ${baseUrl}: ${result.considered} resolvable, ${result.skipped} out of scope, ${selected.length} queued for checking.`,
    );
    if (result.truncated) {
      log.warn(`More links were in scope than MAX_LINKS (${settings.maxLinks}); the remainder was not checked this run.`);
    }
  });

  if (selected.length === 0) {
    const outcome = `No links on ${settings.targetUrl} were in scope; nothing to check.`;
    log.info(outcome);
    return outcome;
  }

  /** @type {ReturnType<typeof links.summarize>} */
  let summary = links.summarize([]);

  await synthetics.executeStep('check', async function () {
    const results = await probe.probeAll(selected, {
      // HEAD first would halve the traffic, but enough origins answer 405 to
      // a HEAD they serve happily as a GET that the saving is not worth the
      // false findings it produces.
      method: 'GET',
      concurrency: settings.concurrency,
      timeoutMs: settings.linkTimeoutMs,
      headers: { 'User-Agent': USER_AGENT },
      followRedirects: false,
    });

    summary = links.summarize(results);

    for (const result of results) {
      const outcome = links.classifyOutcome(result);
      const detail = result.error ?? `status ${result.status}`;
      const line = `${outcome.toUpperCase()} ${result.url} (${detail}, ${result.latencyMs} ms)`;
      if (outcome === 'broken') {
        log.error(line);
      } else if (outcome === 'redirect') {
        log.warn(line);
      } else {
        log.info(line);
      }
    }
  });

  const description = links.describeSummary(summary);
  log.info(description);

  if (summary.broken > 0 && settings.failOnBroken) {
    // Thrown after every link has been probed and logged, so the run artifact
    // holds the complete picture and the failure names the whole set.
    throw new Error(description);
  }

  return selection.truncated ? `${description} Link list was capped at ${settings.maxLinks}.` : description;
};

exports.handler = async () => brokenLinkChecker();
