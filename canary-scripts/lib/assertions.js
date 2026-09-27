'use strict';

/**
 * Assertions shared by the canary scripts.
 *
 * These are deliberately free of any dependency on the Synthetics runtime.
 * They take plain values and return plain values, so the same logic that
 * decides whether a production endpoint is healthy can be exercised in the
 * pipeline without an AWS account, a browser, or a network.
 *
 * The house rule is that an assertion failure carries the observed value. An
 * alarm that says "the API canary failed" starts an investigation; one that
 * says "expected 200, received 503 in 120 ms" often ends it.
 */

/** Raised when an observation does not satisfy its expectation. */
class AssertionFailure extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AssertionFailure';
    this.details = details;
  }
}

/**
 * Compiles a status expectation into a predicate.
 *
 * Accepted forms, in the order they are tried:
 *
 *   `200`         a single status
 *   `200,201,204` any of a list
 *   `200-299`     an inclusive range
 *   `2xx`         a class of statuses
 *   `any`         no constraint, for a check that asserts on the body alone
 *
 * The list form is checked before the range form so that a list containing a
 * range, `200,301-399`, composes rather than failing to parse.
 *
 * @param {string} spec
 * @returns {{ matches: (status: number) => boolean, description: string }}
 */
function parseStatusExpectation(spec) {
  const normalised = String(spec).trim().toLowerCase();
  if (normalised === '') {
    throw new AssertionFailure('A status expectation cannot be empty.');
  }

  if (normalised === 'any') {
    return { matches: () => true, description: 'any status' };
  }

  if (normalised.includes(',')) {
    const parts = normalised
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) {
      throw new AssertionFailure(`Status expectation "${spec}" lists no statuses.`);
    }
    const predicates = parts.map((part) => parseStatusExpectation(part));
    return {
      matches: (status) => predicates.some((predicate) => predicate.matches(status)),
      description: predicates.map((predicate) => predicate.description).join(' or '),
    };
  }

  const rangeMatch = /^([1-5][0-9]{2})-([1-5][0-9]{2})$/.exec(normalised);
  if (rangeMatch) {
    const low = Number(rangeMatch[1]);
    const high = Number(rangeMatch[2]);
    if (low > high) {
      throw new AssertionFailure(`Status range "${spec}" runs backwards.`);
    }
    return {
      matches: (status) => status >= low && status <= high,
      description: `${low}-${high}`,
    };
  }

  const classMatch = /^([1-5])xx$/.exec(normalised);
  if (classMatch) {
    const family = Number(classMatch[1]);
    return {
      matches: (status) => Math.floor(status / 100) === family,
      description: `${family}xx`,
    };
  }

  const exactMatch = /^([1-5][0-9]{2})$/.exec(normalised);
  if (exactMatch) {
    const expected = Number(exactMatch[1]);
    return {
      matches: (status) => status === expected,
      description: String(expected),
    };
  }

  throw new AssertionFailure(
    `Status expectation "${spec}" is not one of: a status (200), a list (200,204), a range (200-299), a class (2xx), or "any".`,
  );
}

/**
 * @param {number} status
 * @param {string} spec
 * @param {{ url?: string, latencyMs?: number }} [context]
 * @returns {void}
 */
function assertStatus(status, spec, context = {}) {
  const expectation = parseStatusExpectation(spec);
  if (expectation.matches(status)) {
    return;
  }
  const where = context.url ? ` from ${context.url}` : '';
  const timing = context.latencyMs === undefined ? '' : ` after ${context.latencyMs} ms`;
  throw new AssertionFailure(
    `Expected status ${expectation.description}${where} but received ${status}${timing}.`,
    { status, expected: expectation.description, ...context },
  );
}

/**
 * Looks for an error signature inside a response body.
 *
 * This is the check a status code cannot make. Plenty of services answer 200
 * with a rendered error page or an envelope carrying `"error"`, and an
 * availability figure built on status codes alone reports those minutes as
 * healthy.
 *
 * Patterns are matched case-insensitively as plain substrings, not regular
 * expressions, so an operator can add one without escaping anything.
 *
 * @param {string} body
 * @param {string[]} patterns
 * @returns {string | null} the first pattern found, or null
 */
function findBodyError(body, patterns) {
  if (typeof body !== 'string' || body === '' || patterns.length === 0) {
    return null;
  }
  const haystack = body.toLowerCase();
  for (const pattern of patterns) {
    if (pattern !== '' && haystack.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

/**
 * @param {string} body
 * @param {string[]} patterns
 * @param {{ url?: string }} [context]
 * @returns {void}
 */
function assertBodyClean(body, patterns, context = {}) {
  const hit = findBodyError(body, patterns);
  if (hit === null) {
    return;
  }
  const where = context.url ? ` returned by ${context.url}` : '';
  throw new AssertionFailure(
    `Response body${where} contains the failure signature "${hit}" despite an acceptable status code.`,
    { pattern: hit, ...context },
  );
}

/**
 * @param {string} body
 * @param {string} needle
 * @param {{ url?: string }} [context]
 * @returns {void}
 */
function assertBodyContains(body, needle, context = {}) {
  if (typeof body === 'string' && body.toLowerCase().includes(needle.toLowerCase())) {
    return;
  }
  const where = context.url ? ` from ${context.url}` : '';
  throw new AssertionFailure(
    `Response body${where} does not contain the expected text "${needle}".`,
    { expected: needle, ...context },
  );
}

/**
 * Resolves a dotted path against a parsed JSON document.
 *
 * Array indices are written as ordinary path segments: `items.0.id`.
 *
 * @param {unknown} document
 * @param {string} path
 * @returns {unknown} the value, or `undefined` if any segment is missing
 */
function readPath(document, path) {
  const segments = path.split('.').filter((segment) => segment !== '');
  /** @type {unknown} */
  let cursor = document;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = /** @type {Record<string, unknown>} */ (cursor)[segment];
  }
  return cursor;
}

/**
 * Asserts a set of dotted-path values against a parsed JSON body.
 *
 * Comparison is by JSON serialisation, so `{"ready": true}` and the string
 * `"true"` are correctly treated as different, while nested objects and
 * arrays compare by value rather than by reference.
 *
 * @param {unknown} document
 * @param {Record<string, unknown>} expectations
 * @param {{ url?: string }} [context]
 * @returns {void}
 */
function assertJsonFields(document, expectations, context = {}) {
  for (const [path, expected] of Object.entries(expectations)) {
    const actual = readPath(document, path);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const where = context.url ? ` from ${context.url}` : '';
      throw new AssertionFailure(
        `Field "${path}"${where} was ${JSON.stringify(actual)} but ${JSON.stringify(expected)} was expected.`,
        { path, actual, expected, ...context },
      );
    }
  }
}

/**
 * @param {number} latencyMs
 * @param {number} budgetMs a budget of 0 disables the check
 * @param {{ url?: string }} [context]
 * @returns {void}
 */
function assertLatencyWithin(latencyMs, budgetMs, context = {}) {
  if (budgetMs <= 0 || latencyMs <= budgetMs) {
    return;
  }
  const where = context.url ? ` ${context.url}` : '';
  throw new AssertionFailure(
    `Request${where} took ${latencyMs} ms, over the ${budgetMs} ms budget.`,
    { latencyMs, budgetMs, ...context },
  );
}

/**
 * Whole days remaining before a certificate expires, rounded down.
 *
 * Rounding down is the safe direction: a certificate with 23 hours left
 * reports 0 rather than 1, so a threshold of "warn below 1" fires.
 *
 * @param {string | number | Date} validTo the notAfter value
 * @param {Date} [now]
 * @returns {number} may be negative for an already-expired certificate
 */
function certificateDaysRemaining(validTo, now = new Date()) {
  const expiry = validTo instanceof Date ? validTo : new Date(validTo);
  if (Number.isNaN(expiry.getTime())) {
    throw new AssertionFailure(`Certificate expiry "${String(validTo)}" could not be parsed.`);
  }
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((expiry.getTime() - now.getTime()) / millisecondsPerDay);
}

/**
 * @param {string | number | Date} validTo
 * @param {number} thresholdDays a threshold of 0 disables the check
 * @param {{ host?: string, now?: Date }} [context]
 * @returns {number} the remaining lifetime, for logging
 */
function assertCertificateLifetime(validTo, thresholdDays, context = {}) {
  const remaining = certificateDaysRemaining(validTo, context.now);
  if (thresholdDays <= 0 || remaining >= thresholdDays) {
    return remaining;
  }
  const where = context.host ? ` for ${context.host}` : '';
  throw new AssertionFailure(
    remaining < 0
      ? `The certificate${where} expired ${Math.abs(remaining)} days ago.`
      : `The certificate${where} expires in ${remaining} days, inside the ${thresholdDays}-day warning threshold.`,
    { remaining, thresholdDays, ...context },
  );
}

module.exports = {
  AssertionFailure,
  assertBodyClean,
  assertBodyContains,
  assertCertificateLifetime,
  assertJsonFields,
  assertLatencyWithin,
  assertStatus,
  certificateDaysRemaining,
  findBodyError,
  parseStatusExpectation,
  readPath,
};
