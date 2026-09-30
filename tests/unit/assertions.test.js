'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const assertions = require('../../canary-scripts/lib/assertions');

/**
 * These assertions decide whether an endpoint is healthy, so the tests are
 * written in both directions throughout: every rule is shown accepting a good
 * observation and refusing a bad one. A rule only ever tested on the failing
 * case would pass identically if it refused everything, and one tested only on
 * the passing case would pass if it asserted nothing at all — which is the
 * failure mode that matters here, because a check that never fails is
 * indistinguishable from a service that never breaks.
 */

test('a status expectation is parsed in every documented form', () => {
  /** @type {Array<[string, number[], number[]]>} */
  const cases = [
    ['200', [200], [201, 404, 500]],
    ['204', [204], [200]],
    ['200,201', [200, 201], [202]],
    ['2xx', [200, 204, 299], [199, 300]],
    ['200-299', [200, 250, 299], [199, 300]],
    ['any', [100, 200, 404, 599], []],
    // A list containing a range has to compose rather than fail to parse,
    // which is why the list form is tried before the range form.
    ['200,301-399', [200, 301, 399], [300, 400, 201]],
    ['2xx,3xx', [200, 301], [400]],
  ];

  for (const [spec, accepted, rejected] of cases) {
    const expectation = assertions.parseStatusExpectation(spec);
    for (const status of accepted) {
      assert.equal(expectation.matches(status), true, `${spec} should accept ${status}`);
    }
    for (const status of rejected) {
      assert.equal(expectation.matches(status), false, `${spec} should reject ${status}`);
    }
  }
});

test('a status expectation is case- and whitespace-insensitive', () => {
  assert.equal(assertions.parseStatusExpectation('  2XX  ').matches(204), true);
  assert.equal(assertions.parseStatusExpectation(' ANY ').matches(418), true);
});

test('a malformed status expectation is refused rather than silently ignored', () => {
  // An unparsed expectation that fell back to "anything" would turn a
  // configuration typo into a canary that passes on every response.
  for (const spec of ['', '   ', 'ok', '600', '99', '0', '2xxx', '200..299', '299-200']) {
    assert.throws(
      () => assertions.parseStatusExpectation(spec),
      (/** @type {Error} */ error) => error.name === 'AssertionFailure',
      `"${spec}" should be refused`,
    );
  }
});

test('assertStatus carries the observed value and the expectation in its message', () => {
  assert.doesNotThrow(() => assertions.assertStatus(200, '2xx'));
  assert.throws(
    () => assertions.assertStatus(503, '2xx', { url: 'https://api.example.test/health', latencyMs: 120 }),
    (/** @type {Error} */ error) =>
      error.message.includes('503') &&
      error.message.includes('2xx') &&
      error.message.includes('https://api.example.test/health') &&
      error.message.includes('120 ms'),
  );
});

test('a body signature is found case-insensitively and reported by name', () => {
  const body = 'Oops — an Internal Server Error occurred while rendering.';
  assert.equal(assertions.findBodyError(body, ['internal server error']), 'internal server error');
  assert.equal(assertions.findBodyError(body, ['gateway timeout']), null);
  assert.throws(
    () => assertions.assertBodyClean(body, ['internal server error'], { url: 'https://api.example.test/' }),
    (/** @type {Error} */ error) => error.message.includes('internal server error'),
  );
});

test('a signature matches whichever way either side is capitalised', () => {
  // Both directions matter, and only one of them is obvious. A pattern is
  // normalised as well as the body, because an operator writes "Internal Server
  // Error" as naturally as the lower-case form — and a pattern that matched
  // nothing would leave the check reporting every minute as healthy.
  assert.equal(assertions.findBodyError('an internal server error occurred', ['Internal Server Error']), 'Internal Server Error');
  assert.equal(assertions.findBodyError('AN INTERNAL SERVER ERROR OCCURRED', ['internal server error']), 'internal server error');
  assert.equal(assertions.findBodyError('An Internal Server Error', ['INTERNAL SERVER ERROR']), 'INTERNAL SERVER ERROR');
});

test('an empty body or an empty pattern list finds nothing', () => {
  assert.equal(assertions.findBodyError('', ['error']), null);
  assert.equal(assertions.findBodyError('error', []), null);
  assert.doesNotThrow(() => assertions.assertBodyClean('error', []));
});

test('patterns are plain substrings, not regular expressions', () => {
  // An operator adds a pattern without escaping anything, so a value full of
  // metacharacters has to match literally.
  const body = 'failed: cost(+30%) [retry]';
  assert.equal(assertions.findBodyError(body, ['cost(+30%)']), 'cost(+30%)');
  assert.equal(assertions.findBodyError('cost 30', ['cost(+30%)']), null);
});

test('assertBodyContains reads in both directions', () => {
  assert.doesNotThrow(() => assertions.assertBodyContains('service is HEALTHY', 'healthy'));
  assert.throws(
    () => assertions.assertBodyContains('maintenance', 'healthy', { url: 'https://app.example.test/' }),
    (/** @type {Error} */ error) => error.message.includes('healthy'),
  );
});

test('readPath walks objects and array indices, and stops at a missing segment', () => {
  const document = { data: { items: [{ id: 'a' }, { id: 'b' }], count: 2, nothing: null } };
  assert.equal(assertions.readPath(document, 'data.count'), 2);
  assert.equal(assertions.readPath(document, 'data.items.1.id'), 'b');
  assert.equal(assertions.readPath(document, 'data.nothing'), null);
  assert.equal(assertions.readPath(document, 'data.missing.deeper'), undefined);
  assert.equal(assertions.readPath(document, 'data.count.deeper'), undefined);
  assert.deepEqual(assertions.readPath(document, ''), document);
});

test('a JSON field expectation compares by value, not by member order', () => {
  // The order of an object's members means nothing in JSON, and a service may
  // change it between two responses that say the same thing. Comparing raw
  // JSON.stringify output would fail a healthy endpoint and print two
  // documents a reader cannot tell apart.
  assert.doesNotThrow(() =>
    assertions.assertJsonFields({ data: { y: 2, x: 1 } }, { data: { x: 1, y: 2 } }),
  );
  assert.doesNotThrow(() =>
    assertions.assertJsonFields(
      { a: { deep: { second: 2, first: 1 } } },
      { a: { deep: { first: 1, second: 2 } } },
    ),
  );
});

test('array order in a JSON field expectation is still significant', () => {
  // Unlike object members, the order of an array is part of what the document
  // says, so relaxing it here would hide a real regression.
  assert.doesNotThrow(() => assertions.assertJsonFields({ ids: [1, 2] }, { ids: [1, 2] }));
  assert.throws(() => assertions.assertJsonFields({ ids: [2, 1] }, { ids: [1, 2] }));
});

test('a JSON field expectation does not confuse types or absence', () => {
  assert.throws(() => assertions.assertJsonFields({ ready: 'true' }, { ready: true }));
  assert.throws(() => assertions.assertJsonFields({ count: '0' }, { count: 0 }));

  // A field holding null and a field that is not there are different answers
  // and the message says which was seen.
  assert.throws(
    () => assertions.assertJsonFields({}, { status: 'ok' }),
    (/** @type {Error} */ error) => error.message.includes('absent'),
  );
  assert.throws(() => assertions.assertJsonFields({ status: null }, { status: 'ok' }));
  assert.doesNotThrow(() => assertions.assertJsonFields({ status: null }, { status: null }));
});

test('canonicalJson distinguishes an absent value from every present one', () => {
  assert.equal(assertions.canonicalJson(undefined), undefined);
  assert.equal(assertions.canonicalJson(null), 'null');
  assert.equal(assertions.canonicalJson(0), '0');
  assert.equal(assertions.canonicalJson(''), '""');
  assert.equal(assertions.canonicalJson(false), 'false');
});

test('canonicalJson matches JSON.stringify on what it drops and what it keeps', () => {
  // A member whose value JSON cannot represent is dropped, and a hole in an
  // array becomes null. Diverging from JSON.stringify here would make an
  // expectation behave differently from the document it is compared against.
  assert.equal(assertions.canonicalJson({ keep: 1, drop: undefined }), '{"keep":1}');
  assert.equal(assertions.canonicalJson([1, undefined, 3]), '[1,null,3]');
  assert.equal(assertions.canonicalJson({ when: new Date('2026-01-02T03:04:05Z') }), '{"when":"2026-01-02T03:04:05.000Z"}');
});

test('a latency budget of zero disables the check and a real budget enforces it', () => {
  assert.doesNotThrow(() => assertions.assertLatencyWithin(9999, 0));
  assert.doesNotThrow(() => assertions.assertLatencyWithin(500, 500));
  assert.throws(
    () => assertions.assertLatencyWithin(501, 500, { url: 'https://api.example.test/' }),
    (/** @type {Error} */ error) => error.message.includes('501') && error.message.includes('500'),
  );
});

test('remaining certificate lifetime rounds down', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  // Rounding down is the safe direction: 23 hours left reports 0, so a
  // "warn below 1 day" threshold fires instead of missing the last day.
  assert.equal(assertions.certificateDaysRemaining('2026-03-01T23:00:00Z', now), 0);
  assert.equal(assertions.certificateDaysRemaining('2026-03-31T00:00:00Z', now), 30);
  assert.equal(assertions.certificateDaysRemaining('2026-02-27T00:00:00Z', now), -2);
});

test("certificate lifetime parses the runtime's own notAfter format", () => {
  // `tls.TLSSocket#getPeerCertificate()` reports `valid_to` in OpenSSL's
  // format, not ISO 8601. Reading it with a parser that only handled ISO
  // would make the expiry check throw on every real connection.
  const now = new Date('2026-03-01T00:00:00Z');
  assert.equal(assertions.certificateDaysRemaining('Mar 31 12:00:00 2026 GMT', now), 30);
});

test('an unparseable expiry is an error rather than a silent skip', () => {
  assert.throws(
    () => assertions.certificateDaysRemaining('not a date'),
    (/** @type {Error} */ error) => error.name === 'AssertionFailure',
  );
});

test('the certificate threshold fires below itself and says which side it is on', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  assert.equal(assertions.assertCertificateLifetime('2026-04-01T00:00:00Z', 14, { now }), 31);
  assert.equal(assertions.assertCertificateLifetime('2026-03-02T00:00:00Z', 0, { now }), 1);

  assert.throws(
    () => assertions.assertCertificateLifetime('2026-03-05T00:00:00Z', 14, { host: 'api.example.test', now }),
    (/** @type {Error} */ error) => error.message.includes('expires in 4 days'),
  );
  assert.throws(
    () => assertions.assertCertificateLifetime('2026-02-20T00:00:00Z', 14, { host: 'api.example.test', now }),
    (/** @type {Error} */ error) => error.message.includes('expired 9 days ago'),
  );
});

test('an assertion failure carries the observation as data, not only as prose', () => {
  // The alarm description is prose; whatever writes a structured artifact
  // needs the values.
  try {
    assertions.assertStatus(500, '200', { url: 'https://api.example.test/', latencyMs: 12 });
    assert.fail('expected a failure');
  } catch (error) {
    const failure = /** @type {import('../../canary-scripts/lib/assertions').AssertionFailure} */ (error);
    assert.equal(failure.details.status, 500);
    assert.equal(failure.details.expected, '200');
    assert.equal(failure.details.latencyMs, 12);
  }
});
