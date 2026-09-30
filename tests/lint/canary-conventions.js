#!/usr/bin/env node
'use strict';

/**
 * Conventions the canary bundle has to keep, checked as a lint.
 *
 * These are not style preferences. Each one is a property the rest of this
 * repository depends on and that nothing else verifies:
 *
 *   - The helpers under `lib/` must not touch the Synthetics runtime, because
 *     that independence is the only reason any of this logic can be exercised
 *     without an AWS account.
 *   - The bundle must carry no third-party code, because it is uploaded whole
 *     into an account and there is no install step to audit.
 *   - A script must document the variables it reads, because its header comment
 *     is what an operator reads when a canary is misconfigured.
 *   - Output must go through the runtime logger, because that is what reaches
 *     the run's log file in the artifacts bucket. A `console.log` is discarded.
 *   - A target must come from the environment, because a hardcoded address
 *     points every deployment of the bundle at whatever was convenient once.
 *
 * Runnable on its own — `node tests/lint/canary-conventions.js` — as well as
 * through the test runner. A check that only works when a test runner is
 * configured stops running the first time the environment changes.
 */

const fs = require('node:fs');
const path = require('node:path');

const scripts = require('../support/scripts');

const RUNTIME_MODULES = ['Synthetics', 'SyntheticsLogger'];

/** @type {string[]} */
const problems = [];
let checks = 0;

/**
 * @param {boolean} condition
 * @param {string} message
 */
function require_(condition, message) {
  checks += 1;
  if (!condition) {
    problems.push(message);
  }
}

/**
 * String literals whose entire content is an absolute URL.
 *
 * Narrow on purpose. A first attempt looked for `https://` anywhere outside a
 * comment, and it flagged this bundle's own error message — the one explaining
 * that `//pricing` resolves to `https://pricing/` — so the lint would have
 * refused a file for being correct. A hardcoded target is a literal that *is* a
 * URL; prose merely mentions one.
 *
 * @param {string} source
 * @returns {string[]}
 */
function urlLiterals(source) {
  const code = scripts.withoutComments(source);
  /** @type {string[]} */
  const found = [];
  const pattern = /(['"`])(https?:\/\/[^'"`\s]+)\1/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    found.push(match[2]);
  }
  return found;
}

/**
 * The part of the README that documents one script: from its own heading to the
 * next heading of the same level.
 *
 * @param {string} readme
 * @param {string} scriptName
 * @returns {string | null}
 */
function documentationSection(readme, scriptName) {
  const heading = new RegExp(`^### \`${scriptName.replace('.', '\\.')}\``, 'm');
  const start = heading.exec(readme);
  if (start === null) {
    return null;
  }
  const rest = readme.slice(start.index + start[0].length);
  const next = /^###? /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

const canaryScripts = scripts.listCanaryScripts();
const libraryModules = scripts.listLibraryModules();
const readme = fs.readFileSync(path.join(scripts.CANARY_SCRIPTS_DIR, 'README.md'), 'utf8');

for (const name of canaryScripts) {
  const source = scripts.readSource(name);
  const header = scripts.headerComment(source);
  const where = name;

  require_(source.startsWith("'use strict';"), `${where}: does not open with 'use strict'`);

  require_(
    scripts.exportsHandler(source),
    `${where}: exports no handler, so the service would fail its first run with a module error`,
  );

  const handlerName = `${name.replace(/\.js$/, '')}.handler`;
  const section = documentationSection(readme, name);
  require_(
    section !== null,
    `${where}: has no section of its own in canary-scripts/README.md`,
  );
  // Scoped to the script's own section rather than to the whole document. The
  // handler also appears in the wiring example near the end, so a check over the
  // file as a whole stays satisfied after the heading that names it has lost it.
  require_(
    section !== null && section.includes(handlerName),
    `${where}: its section in canary-scripts/README.md does not name handler "${handlerName}"`,
  );

  require_(
    /const USER_AGENT = 'synthetic-/.test(source),
    `${where}: declares no synthetic user agent, so its requests are indistinguishable from real traffic in the origin's logs`,
  );

  for (const variable of scripts.environmentVariablesRead(source)) {
    require_(
      header.includes(variable),
      `${where}: reads ${variable} but does not document it in its header comment`,
    );
  }

  for (const specifier of scripts.requiredModules(source)) {
    const permitted =
      specifier.startsWith('node:') || specifier.startsWith('./') || RUNTIME_MODULES.includes(specifier);
    require_(permitted, `${where}: requires "${specifier}", which is neither a builtin, a helper, nor the runtime`);
  }

  const hardcoded = urlLiterals(source);
  require_(
    hardcoded.length === 0,
    `${where}: hardcodes the address ${hardcoded.join(', ')}; targets come from the environment`,
  );

  require_(
    scripts.staticStepNames(source).length > 0 || scripts.hasDynamicStepNames(source),
    `${where}: runs no step, so its work would not appear in the run report`,
  );
}

for (const name of libraryModules) {
  const relativePath = `lib/${name}`;
  const source = scripts.readSource(relativePath);

  require_(source.startsWith("'use strict';"), `${relativePath}: does not open with 'use strict'`);

  for (const specifier of scripts.requiredModules(source)) {
    require_(
      specifier.startsWith('node:') || specifier.startsWith('./'),
      `${relativePath}: requires "${specifier}"; helpers must stay independent of the runtime and of third-party code`,
    );
  }

  require_(
    !RUNTIME_MODULES.some((module) => scripts.requiredModules(source).includes(module)),
    `${relativePath}: imports the Synthetics runtime, which is what makes this logic untestable outside an account`,
  );

  require_(
    urlLiterals(source).length === 0,
    `${relativePath}: hardcodes an absolute address`,
  );
}

for (const relativePath of [...canaryScripts, ...libraryModules.map((name) => `lib/${name}`)]) {
  const code = scripts.codeOnly(scripts.readSource(relativePath));
  require_(
    !/\bconsole\s*\./.test(code),
    `${relativePath}: writes to console; the run log is written by SyntheticsLogger and a console write is discarded`,
  );
}

const build = scripts.readSource('build.sh');
require_(
  build.includes('set -euo pipefail'),
  'build.sh: does not set -euo pipefail, so a failed step would still produce a bundle',
);
require_(
  build.includes('nodejs/node_modules'),
  'build.sh: does not assemble the nodejs/node_modules layout the service requires',
);

// The lint itself has to be shown to be doing something. A rule set that
// matched nothing would report a clean pass over an empty tree.
if (checks < 40) {
  problems.push(`only ${checks} checks ran; the lint is not reading the tree it thinks it is`);
}

if (problems.length > 0) {
  process.stderr.write(`canary-scripts lint: ${problems.length} problem(s) in ${checks} checks\n`);
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `canary-scripts lint: clean — ${checks} checks over ${canaryScripts.length} scripts and ${libraryModules.length} helpers\n`,
  );
}

module.exports = { problems, checks };
