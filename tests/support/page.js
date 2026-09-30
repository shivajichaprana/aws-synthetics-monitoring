'use strict';

/**
 * A Puppeteer `Page` double, with only the surface the canaries actually use.
 *
 * Kept narrow on purpose. A double that answers every method a real page has
 * would let a script call something it should not and still pass; this one
 * throws on anything unconfigured, so a test failure names the assumption the
 * script is making.
 */

/**
 * @param {{
 *   status?: number | null,
 *   url?: string,
 *   text?: string,
 *   hrefs?: Array<string | null>,
 *   selectorFails?: boolean,
 *   maskedCount?: number,
 *   navigationError?: Error,
 *   navigationDelayMs?: number,
 * }} [options]
 */
function createPage(options = {}) {
  /** @type {Array<{ url: string, options: Record<string, unknown> }>} */
  const navigations = [];
  /** @type {string[]} */
  const waitedFor = [];
  /** @type {Array<{ width: number, height: number }>} */
  const viewports = [];
  /** @type {string[]} */
  const userAgents = [];

  let currentUrl = options.url ?? 'https://app.example.test/';

  const page = {
    /**
     * @param {string} url
     * @param {Record<string, unknown>} navigationOptions
     */
    goto: async (url, navigationOptions) => {
      navigations.push({ url, options: navigationOptions });
      // A navigation that takes measurable time. Without it every load is
      // instantaneous, and a latency budget could only ever be shown passing —
      // which a check that never enforced anything would also do.
      if (options.navigationDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.navigationDelayMs));
      }
      if (options.navigationError) {
        throw options.navigationError;
      }
      // A page that redirects reports the address it landed on, which is what
      // the link checker scopes against.
      currentUrl = options.url ?? url;
      const status = options.status === undefined ? 200 : options.status;
      return status === null ? null : { status: () => status };
    },

    url: () => currentUrl,

    /** @param {string} userAgent */
    setUserAgent: async (userAgent) => {
      userAgents.push(userAgent);
    },

    /** @param {{ width: number, height: number }} viewport */
    setViewport: async (viewport) => {
      viewports.push(viewport);
    },

    browser: () => ({ userAgent: async () => 'HeadlessChrome/126.0.0.0' }),

    /**
     * Stands in for `page.evaluate`. The callback runs in the browser in
     * reality, so it is not executed here — the configured answer is returned
     * instead and the call is recorded.
     *
     * @param {(...args: any[]) => unknown} _callback
     * @param {...unknown} args
     */
    evaluate: async (_callback, ...args) => {
      if (args.length > 0) {
        // The masking call passes the selector list. Returning a count is what
        // the script logs, so the double answers with one.
        return options.maskedCount ?? 0;
      }
      return options.text ?? '';
    },

    /**
     * @param {string} selector
     * @param {(elements: unknown[]) => unknown} _mapper
     */
    $$eval: async (selector, _mapper) => {
      waitedFor.push(`$$eval:${selector}`);
      return options.hrefs ?? [];
    },

    /** @param {string} selector */
    waitForSelector: async (selector) => {
      waitedFor.push(selector);
      if (options.selectorFails) {
        throw new Error(`Waiting for selector "${selector}" failed: timeout exceeded`);
      }
      return {};
    },
  };

  return { page, navigations, waitedFor, viewports, userAgents };
}

module.exports = { createPage };
