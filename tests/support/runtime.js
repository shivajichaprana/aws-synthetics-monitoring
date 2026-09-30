'use strict';

const Module = require('node:module');
const path = require('node:path');
const http = require('node:http');

/**
 * A stand-in for the Synthetics runtime.
 *
 * The canary scripts require `Synthetics` and `SyntheticsLogger`, two bare
 * module names the service provides and that exist nowhere else. Without a
 * substitute for them the only testable part of this bundle would be `lib/`,
 * and the scripts on top — which is where the configuration is read, the steps
 * are named and the assertions are ordered — would never be executed by
 * anything until a canary ran in an account.
 *
 * So the loader below intercepts those two names and hands back the doubles in
 * this file. Everything else resolves normally, which means the code under test
 * is the committed script, unmodified, requiring its real helpers.
 *
 * The doubles are deliberately strict rather than permissive. `executeHttpStep`
 * performs a genuine request against the options it is given and passes the
 * real `IncomingMessage` to the validator, so a script that fails to drain the
 * response body hangs here exactly as it would in the service. A double that
 * fabricated a response object instead would pass a script that cannot work.
 */

const CANARY_SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'canary-scripts');

/** @typedef {{ name: string, ok: boolean, error: Error | null }} StepRecord */

/**
 * The chainable configuration object `synthetics.getConfiguration()` returns.
 *
 * Every `withX` call is recorded with its argument. A canary that sets a
 * screenshot flag or a variance threshold is making a decision worth asserting
 * on, and the only place that decision is visible is the call itself.
 *
 * @param {Record<string, unknown>} sink
 * @returns {Record<string, (value: unknown) => unknown>}
 */
function createConfiguration(sink) {
  const handler = {
    /**
     * @param {Record<string, unknown>} _target
     * @param {string | symbol} property
     * @returns {unknown}
     */
    get(_target, property) {
      if (typeof property !== 'string' || !property.startsWith('with')) {
        return undefined;
      }
      return (/** @type {unknown} */ value) => {
        sink[property] = value;
        return proxy;
      };
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy;
}

/**
 * Issues one real request from the options an `executeHttpStep` caller built.
 *
 * @param {Record<string, any>} requestOptions
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function performRequest(requestOptions) {
  return new Promise((resolve, reject) => {
    const { body, ...options } = requestOptions;
    const request = http.request(options, resolve);
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

/**
 * Builds a fresh runtime double.
 *
 * @param {{ page?: unknown }} [options]
 */
function createRuntime(options = {}) {
  /** @type {StepRecord[]} */
  const steps = [];
  /** @type {Array<{ name: string, suffix: string, options: unknown }>} */
  const screenshots = [];
  /** @type {Array<{ level: string, message: string }>} */
  const logs = [];
  /** @type {Record<string, unknown>} */
  const configuration = {};
  /** @type {Array<{ name: string, requestOptions: Record<string, any>, stepConfig: unknown }>} */
  const httpSteps = [];

  const synthetics = {
    getConfiguration: () => createConfiguration(configuration),

    /** @returns {Promise<unknown>} */
    getPage: async () => {
      if (options.page === undefined) {
        throw new Error('This test did not supply a page, but the canary asked for one.');
      }
      return options.page;
    },

    /**
     * @param {string} name
     * @param {() => Promise<unknown>} body
     */
    executeStep: async (name, body) => {
      try {
        const value = await body();
        steps.push({ name, ok: true, error: null });
        return value;
      } catch (error) {
        steps.push({ name, ok: false, error: /** @type {Error} */ (error) });
        // Rethrown, because the service fails the run on a failed step and a
        // double that swallowed it would let a script's error handling go
        // untested.
        throw error;
      }
    },

    /**
     * @param {string} name
     * @param {Record<string, any>} requestOptions
     * @param {(response: import('node:http').IncomingMessage) => Promise<void>} validate
     * @param {unknown} [stepConfig]
     */
    executeHttpStep: async (name, requestOptions, validate, stepConfig) => {
      httpSteps.push({ name, requestOptions, stepConfig });
      try {
        const response = await performRequest(requestOptions);
        await validate(response);
        steps.push({ name, ok: true, error: null });
      } catch (error) {
        steps.push({ name, ok: false, error: /** @type {Error} */ (error) });
        throw error;
      }
    },

    /**
     * @param {string} name
     * @param {string} suffix
     * @param {unknown} [screenshotOptions]
     */
    takeScreenshot: async (name, suffix, screenshotOptions) => {
      screenshots.push({ name, suffix, options: screenshotOptions });
    },
  };

  /** @param {string} level */
  const record = (level) => (/** @type {unknown} */ message) => {
    logs.push({ level, message: String(message) });
  };

  const log = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };

  return {
    synthetics,
    log,
    steps,
    stepNames: () => steps.map((step) => step.name),
    screenshots,
    logs,
    configuration,
    httpSteps,
    /** @param {string} needle */
    logged: (needle) => logs.some((entry) => entry.message.includes(needle)),
  };
}

/**
 * Loads a canary script with the runtime doubles in place.
 *
 * The script and everything under `canary-scripts/` is evicted from the module
 * cache first, so each test gets its own runtime rather than the one the first
 * test happened to install.
 *
 * @param {string} scriptName e.g. 'api-canary.js'
 * @param {{ page?: unknown }} [options]
 */
function loadCanary(scriptName, options = {}) {
  const runtime = createRuntime(options);

  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(CANARY_SCRIPTS_DIR)) {
      delete require.cache[cached];
    }
  }

  const originalLoad = /** @type {any} */ (Module)._load;
  /** @type {any} */ (Module)._load = function (/** @type {string} */ request, ...rest) {
    if (request === 'Synthetics') {
      return runtime.synthetics;
    }
    if (request === 'SyntheticsLogger') {
      return runtime.log;
    }
    return originalLoad.call(this, request, ...rest);
  };

  try {
    const module = require(path.join(CANARY_SCRIPTS_DIR, scriptName));
    return { module, runtime };
  } finally {
    /** @type {any} */ (Module)._load = originalLoad;
  }
}

/**
 * Runs `body` with exactly `env` added to the process environment.
 *
 * The configuration helpers read `process.env` by default, which is what the
 * service does, so the environment is the interface being tested. Keys are
 * removed again afterwards so one test cannot leak a variable into the next.
 *
 * @template T
 * @param {Record<string, string>} env
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withEnv(env, body) {
  /** @type {Record<string, string | undefined>} */
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

module.exports = {
  CANARY_SCRIPTS_DIR,
  createRuntime,
  loadCanary,
  withEnv,
};
