'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const links = require('../../canary-scripts/lib/links');

/**
 * Link selection is where a broken-link check goes wrong, and it goes wrong in
 * one of two directions. Following too much pages somebody at 03:00 because a
 * third-party footer badge rate limited the canary. Following too little
 * reports a clean page it never actually looked at — and that failure is
 * invisible, because a run with nothing in scope and a run with nothing broken
 * produce the same green square.
 */

const BASE = 'https://app.example.test/docs/index.html';

test('a relative link resolves against the page it was found on', () => {
  assert.equal(links.normalizeLink('/pricing', BASE), 'https://app.example.test/pricing');
  assert.equal(links.normalizeLink('guide', BASE), 'https://app.example.test/docs/guide');
  assert.equal(links.normalizeLink('../about', BASE), 'https://app.example.test/about');
  assert.equal(links.normalizeLink('?q=1', BASE), 'https://app.example.test/docs/index.html?q=1');
});

test('a fragment is dropped, because it never reaches the server', () => {
  // This is what makes de-duplication correct rather than approximate: two
  // links differing only by anchor are one request.
  assert.equal(links.normalizeLink('/pricing#plans', BASE), 'https://app.example.test/pricing');
  assert.equal(links.normalizeLink('#top', BASE), null);
  assert.equal(links.normalizeLink('  #  ', BASE), null);
});

test('a link that is not a request is skipped rather than reported', () => {
  // A page legitimately contains these. Treating them as findings would make
  // every run fail on a contact page.
  for (const href of [
    'mailto:hello@example.test',
    'tel:+15550100',
    'javascript:void(0)',
    'data:text/plain,hi',
    'blob:https://app.example.test/1234',
    'sms:+15550100',
    'file:///etc/passwd',
    'about:blank',
    'MAILTO:HELLO@EXAMPLE.TEST',
  ]) {
    assert.equal(links.normalizeLink(href, BASE), null, href);
  }
});

test('a scheme that is not on the skip list is rejected too', () => {
  // The named list is a fast path; the guarantee is that the resolved address
  // has to be http or https. A scheme nobody thought to list has to be refused
  // by that check alone, which is what these are here to pin.
  for (const href of ['ws://app.example.test/socket', 'chrome-extension://abc/page', 'ssh://host/repo']) {
    assert.equal(links.normalizeLink(href, BASE), null, href);
  }
});

test('a relative path that merely starts with a scheme name is still a link', () => {
  // "data/report.csv" and "files/x" begin with the letters of a skipped
  // scheme. A prefix check that forgot the colon would drop them.
  assert.equal(links.normalizeLink('data/report.csv', BASE), 'https://app.example.test/docs/data/report.csv');
  assert.equal(links.normalizeLink('files/x', BASE), 'https://app.example.test/docs/files/x');
  assert.equal(links.normalizeLink('telemetry', BASE), 'https://app.example.test/docs/telemetry');
});

test('a null, empty or unusable href yields null and never throws', () => {
  for (const href of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(links.normalizeLink(/** @type {any} */ (href), BASE), null, String(href));
  }
});

test('same-origin scoping compares the whole origin, not just the host', () => {
  const options = { baseUrl: 'https://app.example.test/', sameOriginOnly: true };
  assert.equal(links.isInScope('https://app.example.test/a', options), true);
  assert.equal(links.isInScope('https://other.example.test/a', options), false);
  // A different scheme or port is a different origin, which is the right
  // answer: an http link on an https page is a finding worth seeing.
  assert.equal(links.isInScope('http://app.example.test/a', options), false);
  assert.equal(links.isInScope('https://app.example.test:8443/a', options), false);
});

test('exclusions win over inclusions', () => {
  // An operator adding an exclusion is reacting to a link that is already
  // making noise. They should not also have to audit the include list.
  const options = {
    baseUrl: 'https://app.example.test/',
    includePatterns: ['/docs/'],
    excludePatterns: ['/docs/legacy/'],
  };
  assert.equal(links.isInScope('https://app.example.test/docs/a', options), true);
  assert.equal(links.isInScope('https://app.example.test/docs/legacy/a', options), false);
  assert.equal(links.isInScope('https://app.example.test/blog/a', options), false);
});

test('an empty include list means no restriction, not no links', () => {
  // The opposite reading would produce a canary that checks nothing and
  // reports a clean page, which looks exactly like a healthy one.
  const options = { baseUrl: 'https://app.example.test/', includePatterns: [], excludePatterns: [] };
  assert.equal(links.isInScope('https://app.example.test/anything', options), true);
});

test('each reason an href was not queued is counted separately', () => {
  // One combined total reported as "out of scope" describes a page of ordinary
  // mail links as a scoping problem, and sends whoever reads the run off to
  // audit a configuration that is working exactly as written.
  const result = links.selectLinks(
    ['mailto:a@example.test', '#top', '/ok', 'https://other.example.test/x', '/ok', '/ok#anchor'],
    { baseUrl: 'https://app.example.test/page', sameOriginOnly: true },
  );

  assert.deepEqual(result.links, ['https://app.example.test/ok']);
  assert.equal(result.considered, 4, 'four hrefs resolved to a fetchable address');
  assert.equal(result.unresolvable, 2, 'the mail link and the anchor are not requests');
  assert.equal(result.outOfScope, 1, 'one link left the origin');
  assert.equal(result.duplicates, 2, '/ok appeared twice more, once only by anchor');
  assert.equal(result.skipped, result.unresolvable + result.outOfScope);
});

test('order is preserved so a capped run spends its budget up the page', () => {
  const hrefs = ['/a', '/b', '/c', '/d'];
  const result = links.selectLinks(hrefs, { baseUrl: 'https://app.example.test/', limit: 2 });
  assert.deepEqual(result.links, ['https://app.example.test/a', 'https://app.example.test/b']);
  assert.equal(result.truncated, true);
});

test('a limit of zero removes the cap rather than queueing nothing', () => {
  const result = links.selectLinks(['/a', '/b'], { baseUrl: 'https://app.example.test/', limit: 0 });
  assert.equal(result.links.length, 2);
  assert.equal(result.truncated, false);
});

test('truncation is only reported when links were actually dropped', () => {
  const exact = links.selectLinks(['/a', '/b'], { baseUrl: 'https://app.example.test/', limit: 2 });
  assert.equal(exact.truncated, false, 'a list exactly at the cap is not truncated');
});

test('an outcome is classified as ok, redirect or broken', () => {
  assert.equal(links.classifyOutcome({ status: 200 }), 'ok');
  assert.equal(links.classifyOutcome({ status: 204 }), 'ok');
  assert.equal(links.classifyOutcome({ status: 301 }), 'redirect');
  assert.equal(links.classifyOutcome({ status: 308 }), 'redirect');
  assert.equal(links.classifyOutcome({ status: 404 }), 'broken');
  assert.equal(links.classifyOutcome({ status: 500 }), 'broken');
  // No status at all is broken, not unknown: the request did not complete.
  assert.equal(links.classifyOutcome({ status: null }), 'broken');
  assert.equal(links.classifyOutcome({ status: 200, error: 'socket hang up' }), 'broken');
});

test('the summary folds outcomes and keeps the broken ones addressable', () => {
  const summary = links.summarize([
    { url: 'https://app.example.test/a', status: 200 },
    { url: 'https://app.example.test/b', status: 301 },
    { url: 'https://app.example.test/c', status: 404 },
    { url: 'https://app.example.test/d', status: null, error: 'No response within 10000 ms.' },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 1);
  assert.equal(summary.redirect, 1);
  assert.equal(summary.broken, 2);
  assert.deepEqual(summary.brokenLinks, [
    { url: 'https://app.example.test/c', status: 404, error: null },
    { url: 'https://app.example.test/d', status: null, error: 'No response within 10000 ms.' },
  ]);
});

test('an empty run summarises to zeros rather than throwing', () => {
  const summary = links.summarize([]);
  assert.deepEqual(summary, { total: 0, ok: 0, redirect: 0, broken: 0, brokenLinks: [] });
});

test('the one-line description names the broken links and counts the rest', () => {
  const clean = links.describeSummary(links.summarize([{ url: 'https://app.example.test/a', status: 200 }]));
  assert.equal(clean, '1 links checked: 1 ok, 0 redirected, 0 broken.');

  const results = Array.from({ length: 7 }, (_unused, index) => ({
    url: `https://app.example.test/${index}`,
    status: 404,
  }));
  const described = links.describeSummary(links.summarize(results), 2);
  assert.match(described, /^7 links checked: 0 ok, 0 redirected, 7 broken\./);
  assert.match(described, /https:\/\/app\.example\.test\/0 \(status 404\)/);
  assert.match(described, /and 5 more\.$/);
  assert.equal(described.includes('/3'), false, 'the sample stops at the size it was given');
});

test('a description prefers the error text over a null status', () => {
  const described = links.describeSummary(
    links.summarize([{ url: 'https://app.example.test/a', status: null, error: 'getaddrinfo ENOTFOUND' }]),
  );
  assert.match(described, /getaddrinfo ENOTFOUND/);
  assert.equal(described.includes('status null'), false);
});
