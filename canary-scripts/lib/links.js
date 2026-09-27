'use strict';

/**
 * Link extraction, scoping and reporting.
 *
 * Split out from the canary that uses it because link selection is where a
 * broken-link check goes wrong, and it is the part that can be exercised
 * without a browser. A checker that follows every `href` on a page will
 * eventually page someone at 03:00 because a third-party footer badge rate
 * limited it.
 */

/** Schemes that are not requests and are never followed. */
const NON_HTTP_SCHEMES = ['mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'sms:', 'file:', 'about:'];

/**
 * Resolves an `href` against the page it was found on.
 *
 * Returns null — rather than throwing — for anything that is not a fetchable
 * HTTP(S) address, because a page legitimately contains plenty of those and
 * they are not findings.
 *
 * @param {string | null | undefined} href
 * @param {string} baseUrl
 * @returns {string | null} an absolute URL with its fragment removed
 */
function normalizeLink(href, baseUrl) {
  if (typeof href !== 'string') {
    return null;
  }
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (NON_HTTP_SCHEMES.some((scheme) => lowered.startsWith(scheme))) {
    return null;
  }

  let resolved;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    return null;
  }

  // The fragment never reaches the server, so two links differing only by
  // anchor are one request. Dropping it here is what makes the dedupe below
  // correct rather than approximately correct.
  resolved.hash = '';
  return resolved.toString();
}

/**
 * Decides whether a resolved link is in scope for checking.
 *
 * @param {string} url
 * @param {{
 *   baseUrl: string,
 *   sameOriginOnly?: boolean,
 *   includePatterns?: string[],
 *   excludePatterns?: string[],
 * }} options
 * @returns {boolean}
 */
function isInScope(url, options) {
  const { baseUrl } = options;
  const sameOriginOnly = options.sameOriginOnly ?? false;
  const includePatterns = options.includePatterns ?? [];
  const excludePatterns = options.excludePatterns ?? [];

  let parsed;
  let base;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  if (sameOriginOnly && parsed.origin !== base.origin) {
    return false;
  }

  // Exclusions win over inclusions. An operator adding an exclusion is
  // reacting to a link that is already causing noise, and they should not
  // have to also audit the include list to make it stop.
  if (excludePatterns.some((pattern) => pattern !== '' && url.includes(pattern))) {
    return false;
  }

  if (includePatterns.length > 0) {
    return includePatterns.some((pattern) => pattern !== '' && url.includes(pattern));
  }

  return true;
}

/**
 * Resolves, filters and de-duplicates the hrefs scraped from a page.
 *
 * Order is preserved so that the links checked first are the ones highest up
 * the page, which is where a capped run should spend its budget.
 *
 * @param {Array<string | null | undefined>} hrefs
 * @param {{
 *   baseUrl: string,
 *   sameOriginOnly?: boolean,
 *   includePatterns?: string[],
 *   excludePatterns?: string[],
 *   limit?: number,
 * }} options
 * @returns {{ links: string[], considered: number, skipped: number, truncated: boolean }}
 */
function selectLinks(hrefs, options) {
  const limit = options.limit ?? 0;
  const seen = new Set();
  /** @type {string[]} */
  const links = [];
  let considered = 0;
  let skipped = 0;

  for (const href of hrefs) {
    const normalized = normalizeLink(href, options.baseUrl);
    if (normalized === null) {
      skipped += 1;
      continue;
    }
    considered += 1;
    if (!isInScope(normalized, options)) {
      skipped += 1;
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    links.push(normalized);
  }

  const truncated = limit > 0 && links.length > limit;
  return {
    links: truncated ? links.slice(0, limit) : links,
    considered,
    skipped,
    truncated,
  };
}

/**
 * Classifies a probe outcome.
 *
 * A redirect is reported separately rather than folded into "ok". Redirects
 * are not failures, but a page whose internal links all redirect is a page
 * one rename away from a broken navigation, and that is worth seeing in the
 * run artifact.
 *
 * @param {{ status: number | null, error?: string | null }} outcome
 * @returns {'ok' | 'redirect' | 'broken'}
 */
function classifyOutcome(outcome) {
  if (outcome.error) {
    return 'broken';
  }
  const { status } = outcome;
  if (status === null || status === undefined) {
    return 'broken';
  }
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  return 'broken';
}

/**
 * Folds per-link outcomes into the summary a run reports.
 *
 * @param {Array<{ url: string, status: number | null, error?: string | null, latencyMs?: number }>} results
 * @returns {{
 *   total: number,
 *   ok: number,
 *   redirect: number,
 *   broken: number,
 *   brokenLinks: Array<{ url: string, status: number | null, error: string | null }>,
 * }}
 */
function summarize(results) {
  const summary = {
    total: results.length,
    ok: 0,
    redirect: 0,
    broken: 0,
    /** @type {Array<{ url: string, status: number | null, error: string | null }>} */
    brokenLinks: [],
  };

  for (const result of results) {
    const outcome = classifyOutcome(result);
    if (outcome === 'ok') {
      summary.ok += 1;
    } else if (outcome === 'redirect') {
      summary.redirect += 1;
    } else {
      summary.broken += 1;
      summary.brokenLinks.push({
        url: result.url,
        status: result.status ?? null,
        error: result.error ?? null,
      });
    }
  }

  return summary;
}

/**
 * Renders the summary as the one line that belongs in an alarm description.
 *
 * @param {ReturnType<typeof summarize>} summary
 * @param {number} [sampleSize] how many broken links to name
 * @returns {string}
 */
function describeSummary(summary, sampleSize = 5) {
  const headline = `${summary.total} links checked: ${summary.ok} ok, ${summary.redirect} redirected, ${summary.broken} broken.`;
  if (summary.broken === 0) {
    return headline;
  }
  const sample = summary.brokenLinks
    .slice(0, sampleSize)
    .map((entry) => `${entry.url} (${entry.error ?? `status ${entry.status}`})`)
    .join('; ');
  const remainder = summary.brokenLinks.length > sampleSize
    ? ` and ${summary.brokenLinks.length - sampleSize} more`
    : '';
  return `${headline} Broken: ${sample}${remainder}.`;
}

module.exports = {
  NON_HTTP_SCHEMES,
  classifyOutcome,
  describeSummary,
  isInScope,
  normalizeLink,
  selectLinks,
  summarize,
};
