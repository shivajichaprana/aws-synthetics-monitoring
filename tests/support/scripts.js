'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Readers over the canary scripts themselves.
 *
 * What these extract are the three things a canary is identified by from
 * outside: the handler the service calls, the step names that become metric
 * dimensions, and the environment variables it reads. All three are also
 * written down somewhere else — in the Terraform, in the alarms, in the
 * documentation — and none of those copies is checked against the source by
 * anything but the tests that use this file.
 */

const CANARY_SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'canary-scripts');
const LIB_DIR = path.join(CANARY_SCRIPTS_DIR, 'lib');

/**
 * The canary entry points: a `.js` file at the top of the scripts directory.
 * This is the same convention `build.sh` uses to decide what to package.
 *
 * @returns {string[]}
 */
function listCanaryScripts() {
  const scripts = fs
    .readdirSync(CANARY_SCRIPTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();

  if (scripts.length === 0) {
    throw new Error('No canary scripts were found; this reader is looking in the wrong place.');
  }
  return scripts;
}

/**
 * @returns {string[]} helper module file names, relative to lib/
 */
function listLibraryModules() {
  const modules = fs
    .readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();

  if (modules.length === 0) {
    throw new Error('No helper modules were found under lib/; this reader is looking in the wrong place.');
  }
  return modules;
}

/**
 * @param {string} relativePath relative to canary-scripts/
 * @returns {string}
 */
function readSource(relativePath) {
  return fs.readFileSync(path.join(CANARY_SCRIPTS_DIR, relativePath), 'utf8');
}

/**
 * Removes comments and string literals, so that a check for a construct in the
 * code cannot be satisfied — or defeated — by prose or by an example.
 *
 * A file's own explanation of a rule frequently contains the thing the rule
 * forbids, which is how a lint gets a file wrong for being correct.
 *
 * @param {string} source
 * @returns {string}
 */
function codeOnly(source) {
  let output = '';
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      // A placeholder keeps token boundaries intact, so `require('x')` still
      // reads as a call rather than collapsing into `require()`.
      output += '""';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          index += 1;
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/**
 * Removes comments but keeps string literals.
 *
 * The opposite of `codeOnly`, and needed for the checks that look for a value
 * written into the code — a hardcoded address, say — where the literal is the
 * whole point and a file's prose about it is not.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  let output = '';
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      output += character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          output += source[index];
          index += 1;
        }
        output += source[index];
        index += 1;
      }
      output += quote;
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/**
 * The leading block comment of a file, which is where each script documents the
 * variables it reads.
 *
 * @param {string} source
 * @returns {string}
 */
function headerComment(source) {
  const match = /\/\*\*[\s\S]*?\*\//.exec(source);
  return match === null ? '' : match[0];
}

/**
 * Step names the script passes as a literal.
 *
 * A step name is not cosmetic: the latency alarms scope the `Duration` metric to
 * a `StepName` dimension, so a renamed step detaches an alarm from its metric
 * without anything failing.
 *
 * @param {string} source
 * @returns {string[]}
 */
function staticStepNames(source) {
  /** @type {string[]} */
  const names = [];
  const pattern = /execute(?:Http)?Step\(\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * True when the script names at least one step from configuration rather than
 * from a literal, as the visual journey does.
 *
 * @param {string} source
 * @returns {boolean}
 */
function hasDynamicStepNames(source) {
  return /execute(?:Http)?Step\(\s*[^'\s]/.test(source);
}

/**
 * Environment variables the script reads.
 *
 * `config.headers()` is special-cased because it reads `REQUEST_HEADERS`
 * itself: the variable is genuinely part of the caller's interface, and a
 * reader that only looked for a quoted name at a call site would miss it.
 *
 * @param {string} source
 * @returns {string[]}
 */
function environmentVariablesRead(source) {
  /** @type {Set<string>} */
  const names = new Set();

  const pattern = /config\.[A-Za-z]+\(\s*'([A-Z][A-Z0-9_]*)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    names.add(match[1]);
  }

  if (/config\.headers\(/.test(source)) {
    names.add('REQUEST_HEADERS');
  }

  return [...names].sort();
}

/**
 * @param {string} source
 * @returns {boolean}
 */
function exportsHandler(source) {
  return /exports\.handler\s*=/.test(codeOnly(source));
}

/**
 * Module specifiers the file requires.
 *
 * @param {string} source
 * @returns {string[]}
 */
function requiredModules(source) {
  /** @type {string[]} */
  const specifiers = [];
  const pattern = /require\(\s*'([^']+)'\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

module.exports = {
  CANARY_SCRIPTS_DIR,
  LIB_DIR,
  codeOnly,
  environmentVariablesRead,
  exportsHandler,
  hasDynamicStepNames,
  headerComment,
  listCanaryScripts,
  listLibraryModules,
  readSource,
  requiredModules,
  staticStepNames,
  withoutComments,
};
