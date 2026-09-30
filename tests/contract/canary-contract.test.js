'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const terraform = require('../support/terraform');
const scripts = require('../support/scripts');

/**
 * The agreements between the configuration and the code it deploys.
 *
 * Everything here is a statement that exists twice — once in Terraform and once
 * in a script — with nothing keeping the two copies honest. Each of these
 * mismatches would be accepted by AWS, would apply cleanly, and would then
 * produce a canary or an alarm that is running, healthy-looking, and answering
 * a question nobody asked:
 *
 *   - A handler naming a file that is not in the bundle fails the canary's
 *     first run with a module error that says nothing about the layout.
 *   - A step name the alarm scopes its metric to, but that the script never
 *     runs, gives an alarm whose metric has no data. With missing data left
 *     missing it never leaves INSUFFICIENT_DATA, so it never alerts, and a
 *     dashboard shows an alarm that is not in ALARM.
 *   - A variable the configuration sets that the script does not read is a
 *     setting somebody will change expecting an effect.
 *   - A variable the script requires that the configuration does not set fails
 *     every run of that canary, from the first one.
 */

test('the configuration creates the canaries this bundle has scripts for', () => {
  const canaries = terraform.builtinCanaries();
  const available = scripts.listCanaryScripts();

  assert.ok(Object.keys(canaries).length >= 2, 'the built-in set should not have shrunk unnoticed');

  for (const [key, canary] of Object.entries(canaries)) {
    const [file, exported] = canary.handler.split('.');
    assert.ok(
      available.includes(`${file}.js`),
      `canary "${key}" names handler ${canary.handler}, but ${file}.js is not in the bundle`,
    );
    assert.equal(exported, 'handler', `canary "${key}" must call the exported handler`);
    assert.ok(
      scripts.exportsHandler(scripts.readSource(`${file}.js`)),
      `${file}.js does not export a handler`,
    );
  }
});

test('every variable the configuration sets is read by the script it is set for', () => {
  const canaries = terraform.builtinCanaries();

  for (const [key, canary] of Object.entries(canaries)) {
    const file = `${canary.handler.split('.')[0]}.js`;
    const read = scripts.environmentVariablesRead(scripts.readSource(file));

    assert.ok(canary.environmentVariables.length > 0, `canary "${key}" was read as setting no variables at all`);

    for (const variable of canary.environmentVariables) {
      assert.ok(
        read.includes(variable),
        `the configuration sets ${variable} on canary "${key}", but ${file} never reads it`,
      );
    }
  }
});

test('every canary is given the one variable its script cannot run without', () => {
  // TARGET_URL is the only input with no default anywhere in the bundle, so a
  // canary created without it fails on its opening run.
  for (const [key, canary] of Object.entries(terraform.builtinCanaries())) {
    assert.ok(
      canary.environmentVariables.includes('TARGET_URL'),
      `canary "${key}" is created without TARGET_URL and could never complete a run`,
    );
  }
});

test('every step name the latency alarms scope to is a step its script runs', () => {
  const steps = terraform.builtinLatencySteps();
  const canaries = terraform.builtinCanaries();

  assert.ok(Object.keys(steps).length >= 2, 'the latency step map should not have shrunk unnoticed');

  for (const [key, stepName] of Object.entries(steps)) {
    const canary = canaries[key];
    assert.ok(canary, `the latency step map names "${key}", which is not a built-in canary`);

    const file = `${canary.handler.split('.')[0]}.js`;
    const names = scripts.staticStepNames(scripts.readSource(file));
    assert.ok(
      names.includes(stepName),
      `the latency alarm for "${key}" scopes to step "${stepName}", but ${file} runs ${JSON.stringify(names)}`,
    );
  }
});

test('a script with no fixed step names is not given a latency step', () => {
  // The visual journey names its steps from configuration, so a step name
  // written into the configuration here could not be verified and would be a
  // dimension matching whatever the operator happened to call a view.
  const steps = terraform.builtinLatencySteps();
  const canaries = terraform.builtinCanaries();

  for (const [key, stepName] of Object.entries(steps)) {
    const file = `${canaries[key].handler.split('.')[0]}.js`;
    const source = scripts.readSource(file);
    if (scripts.staticStepNames(source).length === 0) {
      assert.fail(`"${key}" is given the step name "${stepName}" but ${file} names its steps dynamically`);
    }
  }
});

test('the handlers the documented example wires up all exist', () => {
  // The example in canary-scripts/README.md is copied into a tfvars file by
  // whoever adds the link or visual check, so a handler that has drifted there
  // becomes somebody's failed apply.
  const readme = scripts.readSource('README.md');
  const referenced = [...readme.matchAll(/handler\s*=\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(referenced.length >= 2, 'the wiring example should still be in the documentation');

  for (const handler of referenced) {
    const [file, exported] = handler.split('.');
    assert.ok(
      scripts.listCanaryScripts().includes(`${file}.js`),
      `the documented example names ${handler}, which is not in the bundle`,
    );
    assert.equal(exported, 'handler', handler);
  }
});

test('every script in the bundle is documented, and every documented one exists', () => {
  const readme = scripts.readSource('README.md');
  const documented = new Set(
    [...readme.matchAll(/### `([a-z0-9-]+\.js)`/g)].map((match) => match[1]),
  );
  const present = new Set(scripts.listCanaryScripts());

  assert.deepEqual([...documented].sort(), [...present].sort());
});

test('the packaged bundle contains every script and helper, in the layout the service expects', () => {
  // A Node.js canary is a zip whose contents sit under nodejs/node_modules/.
  // Anything laid out differently fails at the first run with a module-not-found
  // error that says nothing about the layout, so the build is run for real here
  // rather than asserted about.
  const output = execFileSync(path.join(scripts.CANARY_SCRIPTS_DIR, 'build.sh'), {
    encoding: 'utf8',
    env: { ...process.env, OUTPUT_DIR: path.join(scripts.CANARY_SCRIPTS_DIR, 'dist'), BUNDLE_NAME: 'contract.zip' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  const listing = execFileSync('zip', ['-sf', output], { encoding: 'utf8' });

  for (const name of scripts.listCanaryScripts()) {
    assert.match(listing, new RegExp(`nodejs/node_modules/${name.replace('.', '\\.')}`), name);
  }
  for (const name of scripts.listLibraryModules()) {
    assert.match(listing, new RegExp(`nodejs/node_modules/lib/${name.replace('.', '\\.')}`), name);
  }
});

test('the conventions lint passes when run on its own', () => {
  // Run as a subprocess rather than required, because the pipeline runs it that
  // way and an import-time pass is not the same thing as an exit code.
  const output = execFileSync('node', [path.resolve(__dirname, '..', 'lint', 'canary-conventions.js')], {
    encoding: 'utf8',
  });
  assert.match(output, /clean/);
});
