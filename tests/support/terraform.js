'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Narrow readers for the two facts the canary scripts have to agree with.
 *
 * There is no HCL parser here on purpose: this bundle carries no dependencies,
 * and adding one so that a test can read two maps would be a poor trade. What
 * makes a textual reader acceptable instead is that every one of them is
 * checked for having found something. A regex that silently matches nothing
 * reports a clean pass over an empty set, which is the most expensive kind of
 * green there is — the reason these helpers throw rather than return empty.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Returns the text between a `{` and its matching `}`, starting the search at
 * the first `{` at or after `from`.
 *
 * @param {string} text
 * @param {number} from
 * @returns {{ body: string, end: number }}
 */
function balancedBraces(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) {
    throw new Error(`No opening brace after offset ${from}.`);
  }

  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open + 1, index), end: index };
      }
    }
  }

  throw new Error(`Unbalanced braces starting at offset ${open}.`);
}

/**
 * Returns the text between a `(` and its matching `)`, starting at the first
 * `(` at or after `from`.
 *
 * Needed because the canary set is the argument list of a `merge(...)` call
 * whose first element is a ternary with an empty map in it. Balancing braces
 * from the assignment would find that empty map and read a set of no canaries —
 * which is exactly what the count check below caught the first time this reader
 * was written.
 *
 * @param {string} text
 * @param {number} from
 * @returns {{ body: string, end: number }}
 */
function balancedParens(text, from) {
  const open = text.indexOf('(', from);
  if (open === -1) {
    throw new Error(`No opening parenthesis after offset ${from}.`);
  }

  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open + 1, index), end: index };
      }
    }
  }

  throw new Error(`Unbalanced parentheses starting at offset ${open}.`);
}

/**
 * Strips `#` and `//` comments so that a commented-out attribute is not read as
 * a live one. String contents are preserved.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let inString = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (inString) {
          if (character === '\\') {
            index += 1;
          } else if (character === '"') {
            inString = false;
          }
          continue;
        }
        if (character === '"') {
          inString = true;
        } else if (character === '#' || (character === '/' && line[index + 1] === '/')) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function readConfigurationFile(relativePath) {
  return withoutComments(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

/**
 * The canaries the configuration creates by itself, keyed as the configuration
 * keys them.
 *
 * @returns {Record<string, { handler: string, environmentVariables: string[] }>}
 */
function builtinCanaries() {
  const text = readConfigurationFile('locals.tf');
  const anchor = text.indexOf('builtin_canaries');
  if (anchor === -1) {
    throw new Error('locals.tf no longer declares builtin_canaries; this reader needs updating.');
  }

  // The set is the argument list of a merge() call, so the parentheses are what
  // bound it. Anything else would stop at the first brace, which belongs to a
  // ternary's empty map rather than to a canary.
  const { body } = balancedParens(text, anchor);

  /** @type {Record<string, { handler: string, environmentVariables: string[] }>} */
  const canaries = {};

  const blockPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/g;
  let match;
  while ((match = blockPattern.exec(body)) !== null) {
    const { body: block, end } = balancedBraces(body, match.index);
    const handler = /(?:^|\n)\s*handler\s*=\s*"([^"]+)"/.exec(block);
    if (handler === null) {
      continue;
    }

    const environmentVariables = [];
    const environmentAnchor = block.indexOf('environment_variables');
    if (environmentAnchor !== -1) {
      const { body: environmentBlock } = balancedBraces(block, environmentAnchor);
      const variablePattern = /(?:^|\n)\s*([A-Z][A-Z0-9_]*)\s*=/g;
      let variable;
      while ((variable = variablePattern.exec(environmentBlock)) !== null) {
        environmentVariables.push(variable[1]);
      }
    }

    canaries[match[1]] = { handler: handler[1], environmentVariables };

    // The inner block is consumed so a nested attribute cannot be mistaken for
    // another canary.
    blockPattern.lastIndex = end;
  }

  if (Object.keys(canaries).length === 0) {
    throw new Error('No built-in canaries were read out of locals.tf; the reader is matching nothing.');
  }
  return canaries;
}

/**
 * The per-canary step name the latency alarm scopes its metric to.
 *
 * @returns {Record<string, string>}
 */
function builtinLatencySteps() {
  const text = readConfigurationFile('locals.tf');
  const anchor = text.indexOf('slo_builtin_latency_steps');
  if (anchor === -1) {
    throw new Error('locals.tf no longer declares slo_builtin_latency_steps; this reader needs updating.');
  }

  const { body } = balancedBraces(text, anchor);

  /** @type {Record<string, string>} */
  const steps = {};
  const pattern = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    steps[match[1]] = match[2];
  }

  if (Object.keys(steps).length === 0) {
    throw new Error('No latency step names were read out of locals.tf; the reader is matching nothing.');
  }
  return steps;
}

module.exports = {
  REPO_ROOT,
  balancedBraces,
  balancedParens,
  builtinCanaries,
  builtinLatencySteps,
  readConfigurationFile,
  withoutComments,
};
