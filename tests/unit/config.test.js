'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../canary-scripts/lib/config');

/**
 * The environment is the whole interface between a canary and the deployment
 * that created it, so these tests care most about the two ways a reader can be
 * wrong in a way nobody notices: accepting a value it should have refused, and
 * treating a value that was set as though it were absent.
 */

test('an absent, empty or whitespace-only variable is the same as unset', () => {
  for (const value of [undefined, '', '   ', '\t\n']) {
    const env = value === undefined ? {} : { OPTIONAL: value };
    assert.equal(config.optionalString('OPTIONAL', 'fallback', { env }), 'fallback');
  }
});

test('a required variable names itself when it is missing', () => {
  assert.throws(
    () => config.requiredString('TARGET_URL', { env: {} }),
    (/** @type {Error} */ error) =>
      error.name === 'ConfigurationError' && error.message.includes('TARGET_URL'),
  );
});

test('a required string keeps surrounding whitespace out of the value', () => {
  assert.equal(config.requiredString('NAME', { env: { NAME: '  edge  ' } }), 'edge');
});

test('requiredUrl refuses anything that is not an absolute HTTP address', () => {
  const rejected = [
    'file:///etc/passwd',
    'data:text/html,<p>hi</p>',
    'javascript:void(0)',
    'app.example.test/health',
    'ftp://files.example.test/x',
    '/relative/path',
  ];
  for (const value of rejected) {
    assert.throws(
      () => config.requiredUrl('TARGET_URL', { env: { TARGET_URL: value } }),
      (/** @type {Error} */ error) => error.name === 'ConfigurationError',
      `"${value}" should not be accepted as a target`,
    );
  }
});

test('requiredUrl accepts http and https and normalises the value', () => {
  assert.equal(
    config.requiredUrl('TARGET_URL', { env: { TARGET_URL: 'https://app.example.test' } }),
    'https://app.example.test/',
  );
  assert.equal(
    config.requiredUrl('TARGET_URL', { env: { TARGET_URL: 'http://app.example.test/health?deep=1' } }),
    'http://app.example.test/health?deep=1',
  );
});

test('an allowed-protocol list is enforced and named in the message', () => {
  assert.throws(
    () =>
      config.requiredUrl('TARGET_URL', {
        env: { TARGET_URL: 'http://app.example.test/' },
        allowedProtocols: ['https:'],
      }),
    (/** @type {Error} */ error) => error.message.includes('https:'),
  );
});

test('optionalUrl returns null when unset but still validates when set', () => {
  assert.equal(config.optionalUrl('EXTRA', { env: {} }), null);
  assert.throws(() => config.optionalUrl('EXTRA', { env: { EXTRA: 'nonsense' } }));
});

test('integer refuses a value that only starts with a number', () => {
  // `parseInt('12abc')` is 12, which would accept a typo as a setting. The
  // reader uses Number() precisely so that it does not.
  for (const value of ['12abc', '1.5', 'many', '', ' ']) {
    const env = { TIMEOUT: value };
    if (value.trim() === '') {
      assert.equal(config.integer('TIMEOUT', { env, fallback: 7 }), 7);
    } else {
      assert.throws(() => config.integer('TIMEOUT', { env }), (/** @type {Error} */ e) => e.name === 'ConfigurationError');
    }
  }
});

test('integer enforces its bounds and reports the offending value', () => {
  assert.throws(
    () => config.integer('MAX_LINKS', { env: { MAX_LINKS: '5000' }, min: 0, max: 1000 }),
    (/** @type {Error} */ error) => error.message.includes('1000') && error.message.includes('5000'),
  );
  assert.throws(() => config.integer('CONCURRENCY', { env: { CONCURRENCY: '0' }, min: 1 }));
  assert.equal(config.integer('CONCURRENCY', { env: { CONCURRENCY: '4' }, min: 1, max: 20 }), 4);
});

test('integer with no value and no fallback is an error, not a zero', () => {
  assert.throws(() => config.integer('REQUIRED_NUMBER', { env: {} }));
  assert.equal(config.integer('OPTIONAL_NUMBER', { env: {}, fallback: 0 }), 0);
});

test('boolean accepts the spellings people actually write', () => {
  for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'On']) {
    assert.equal(config.boolean('FLAG', { env: { FLAG: value } }), true, value);
  }
  for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(config.boolean('FLAG', { env: { FLAG: value } }), false, value);
  }
});

test('boolean refuses a value it cannot read rather than guessing false', () => {
  // Guessing would turn a typo into a silently disabled check.
  assert.throws(() => config.boolean('FAIL_ON_BROKEN', { env: { FAIL_ON_BROKEN: 'ture' } }));
});

test('list trims entries and drops the empty ones', () => {
  assert.deepEqual(
    config.list('PATTERNS', { env: { PATTERNS: ' a , ,b,, c ' } }),
    ['a', 'b', 'c'],
  );
});

test('list treats an empty variable as unset and hands back the fallback', () => {
  // This is the behaviour that makes an explicit "none" sentinel necessary in
  // the API canary: clearing a variable cannot mean "empty list", because a
  // templated unset input arrives as an empty string too.
  assert.deepEqual(config.list('PATTERNS', { env: { PATTERNS: '' }, fallback: ['default'] }), ['default']);
  assert.deepEqual(config.list('PATTERNS', { env: { PATTERNS: ',' }, fallback: ['default'] }), []);
});

test('json parses, falls back, and refuses invalid documents', () => {
  assert.deepEqual(config.json('FIELDS', { env: { FIELDS: '{"a":1}' } }), { a: 1 });
  assert.equal(config.json('FIELDS', { env: {} }), null);
  assert.deepEqual(config.json('FIELDS', { env: {}, fallback: {} }), {});
  assert.throws(
    () => config.json('FIELDS', { env: { FIELDS: '{not json}' } }),
    (/** @type {Error} */ error) => error.message.includes('FIELDS'),
  );
});

test('headers adds a user agent only when none was supplied', () => {
  assert.deepEqual(config.headers({ env: {}, userAgent: 'synthetic' }), { 'User-Agent': 'synthetic' });

  // Case-insensitively: a supplied lower-case header must not end up alongside
  // a second one with different capitalisation, which some servers log as two.
  assert.deepEqual(
    config.headers({ env: { REQUEST_HEADERS: '{"user-agent":"mine"}' }, userAgent: 'synthetic' }),
    { 'user-agent': 'mine' },
  );
});

test('headers stringifies non-string values and refuses a non-object', () => {
  assert.deepEqual(config.headers({ env: { REQUEST_HEADERS: '{"x-retry":3}' } }), { 'x-retry': '3' });
  for (const value of ['[1,2]', '"text"', '7', 'null']) {
    assert.throws(
      () => config.headers({ env: { REQUEST_HEADERS: value } }),
      (/** @type {Error} */ error) => error.name === 'ConfigurationError',
      value,
    );
  }
});
