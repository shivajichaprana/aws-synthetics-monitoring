'use strict';

/**
 * Environment parsing for canary scripts.
 *
 * A canary receives every piece of per-deployment configuration as an
 * environment variable, because the script bundle is shared by every canary in
 * the deployment and only the variables differ. That makes the parsing layer
 * the first place a misconfiguration can be caught, and the last place it can
 * be caught cheaply: a bad value that slips through here surfaces as a failed
 * run and a paged engineer rather than as a plan-time error.
 *
 * Every reader therefore fails loudly with a message naming the variable and
 * the constraint it broke. None of them fall back to a "sensible" value for a
 * variable that was set but unparseable, because silently monitoring the wrong
 * thing is worse than not monitoring at all.
 */

/** Raised when an environment variable is missing or cannot be parsed. */
class ConfigurationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Reads a variable and normalises "absent" to `undefined`.
 *
 * An empty or whitespace-only string counts as absent. Infrastructure that
 * templates these values tends to emit an empty string for an unset optional
 * input, and treating that as a present-but-empty value produces confusing
 * downstream errors.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined}
 */
function rawValue(env, name) {
  const value = env[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
function requiredString(name, options = {}) {
  const env = options.env ?? process.env;
  const value = rawValue(env, name);
  if (value === undefined) {
    throw new ConfigurationError(`${name} is required but was not set. Set it on the canary's run configuration.`);
  }
  return value;
}

/**
 * @param {string} name
 * @param {string | null} [fallback]
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string | null}
 */
function optionalString(name, fallback = null, options = {}) {
  const env = options.env ?? process.env;
  return rawValue(env, name) ?? fallback;
}

/**
 * Parses a URL, rejecting anything that is not an absolute HTTP(S) address.
 *
 * `new URL()` accepts a great many things a canary must not be pointed at —
 * `file:`, `data:`, and bare hostnames among them — so the protocol check is
 * not redundant with the parse.
 *
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, allowedProtocols?: string[] }} [options]
 * @returns {string}
 */
function requiredUrl(name, options = {}) {
  const allowedProtocols = options.allowedProtocols ?? ['https:', 'http:'];
  const value = requiredString(name, options);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} is not a valid absolute URL: ${value}`);
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(
      `${name} uses protocol ${parsed.protocol} but only ${allowedProtocols.join(', ')} are accepted.`,
    );
  }

  return parsed.toString();
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, allowedProtocols?: string[] }} [options]
 * @returns {string | null}
 */
function optionalUrl(name, options = {}) {
  const env = options.env ?? process.env;
  if (rawValue(env, name) === undefined) {
    return null;
  }
  return requiredUrl(name, options);
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, fallback?: number, min?: number, max?: number }} [options]
 * @returns {number}
 */
function integer(name, options = {}) {
  const env = options.env ?? process.env;
  const value = rawValue(env, name);

  if (value === undefined) {
    if (options.fallback === undefined) {
      throw new ConfigurationError(`${name} is required but was not set.`);
    }
    return options.fallback;
  }

  // `Number()` rather than `parseInt()`: parseInt('12abc') is 12, which would
  // accept a typo as a valid setting.
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${name} must be a whole number but was ${value}.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new ConfigurationError(`${name} must be at least ${options.min} but was ${parsed}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new ConfigurationError(`${name} must be at most ${options.max} but was ${parsed}.`);
  }
  return parsed;
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, fallback?: boolean }} [options]
 * @returns {boolean}
 */
function boolean(name, options = {}) {
  const env = options.env ?? process.env;
  const value = rawValue(env, name);
  if (value === undefined) {
    return options.fallback ?? false;
  }

  const normalised = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalised)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalised)) {
    return false;
  }
  throw new ConfigurationError(`${name} must be a boolean (true/false) but was ${value}.`);
}

/**
 * Splits a comma-separated variable, dropping empty entries.
 *
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, fallback?: string[] }} [options]
 * @returns {string[]}
 */
function list(name, options = {}) {
  const env = options.env ?? process.env;
  const value = rawValue(env, name);
  if (value === undefined) {
    return options.fallback ?? [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, fallback?: unknown }} [options]
 * @returns {unknown}
 */
function json(name, options = {}) {
  const env = options.env ?? process.env;
  const value = rawValue(env, name);
  if (value === undefined) {
    return options.fallback ?? null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ConfigurationError(`${name} must contain valid JSON: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * Builds the header map a probe sends.
 *
 * The user agent is set deliberately. An unlabelled synthetic request is
 * indistinguishable from real traffic in the origin's logs, which skews every
 * request-rate panel the same dashboards later plot.
 *
 * @param {{ env?: NodeJS.ProcessEnv, userAgent?: string }} [options]
 * @returns {Record<string, string>}
 */
function headers(options = {}) {
  const parsed = json('REQUEST_HEADERS', { env: options.env, fallback: {} });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationError('REQUEST_HEADERS must be a JSON object of header names to values.');
  }

  /** @type {Record<string, string>} */
  const result = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
    result[key] = String(value);
  }

  const hasUserAgent = Object.keys(result).some((key) => key.toLowerCase() === 'user-agent');
  if (!hasUserAgent && options.userAgent) {
    result['User-Agent'] = options.userAgent;
  }
  return result;
}

module.exports = {
  ConfigurationError,
  boolean,
  headers,
  integer,
  json,
  list,
  optionalString,
  optionalUrl,
  requiredString,
  requiredUrl,
};
