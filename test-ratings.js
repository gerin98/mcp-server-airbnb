import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractRating, filterByRating, validateRatingOptions } from './dist/ratings.js';
import { discoverPartialStays } from './dist/partial-stays.js';
import { describeAvailability } from './dist/availability.js';

const fixture = JSON.parse(readFileSync(new URL('./test/fixtures/ratings.json', import.meta.url)));

test('rating and review count are numeric or null for captured Airbnb cards', () => {
  for (const sample of fixture.cases) assert.deepEqual(extractRating(sample.input), sample.expected);
});

test('accessibility counts remain exact when compact counts are abbreviated', () => {
  assert.deepEqual(extractRating({ avgRatingA11yLabel: '4.95 out of 5 average rating, 1,234 reviews', avgRatingLocalized: '4.95 (1K)' }), { rating: 4.95, reviewCount: 1234 });
  assert.deepEqual(extractRating({ avgRatingLocalized: '4.5 (1,234)' }), { rating: 4.5, reviewCount: 1234 });
  assert.deepEqual(extractRating({ avgRatingA11yLabel: '5.0 out of 5 average rating, 1 review' }), { rating: 5, reviewCount: 1 });
  assert.deepEqual(extractRating({ avgRatingA11yLabel: '4.95 out of 5 average rating', avgRatingLocalized: '4.9 (12)' }), { rating: 4.95, reviewCount: 12 });
});

test('new, missing, approximate and malformed data never invents ratings or review counts', () => {
  for (const input of [{}, { avgRatingA11yLabel: 'New place to stay', avgRatingLocalized: 'New' }, { badges: [{ text: 'Guest favorite' }] }, { avgRatingA11yLabel: 4.9 }]) {
    assert.deepEqual(extractRating(input), { rating: null, reviewCount: null });
  }
  assert.deepEqual(extractRating({ avgRatingLocalized: '4.5 (1K)' }), { rating: 4.5, reviewCount: null });
  for (const count of ['1,23', '1.2K', '-1', '9007199254740992']) {
    assert.equal(extractRating({ avgRatingA11yLabel: `4.5 out of 5 average rating, ${count} reviews` }).reviewCount, null);
  }
  assert.deepEqual(extractRating({ avgRatingLocalized: '4,5 (10)' }), { rating: null, reviewCount: null });
  assert.deepEqual(extractRating({ avgRatingLocalized: '6.5 (10)' }), { rating: null, reviewCount: 10 });
  assert.deepEqual(extractRating({ avgRatingA11yLabel: 'No reviews yet' }), { rating: null, reviewCount: 0 });
  assert.deepEqual(extractRating({ avgRatingLocalized: '5.0 (0)' }), { rating: null, reviewCount: 0 });
});

const rows = [
  { id: 'boundary', rating: 4.5, reviewCount: 10 },
  { id: 'few', rating: 5, reviewCount: 1 },
  { id: 'low', rating: 4.49, reviewCount: 100 },
  { id: 'unknown-rating', rating: null, reviewCount: 20 },
  { id: 'unknown-count', rating: 4.9, reviewCount: null },
  { id: 'new', rating: null, reviewCount: null },
];

test('both thresholds are inclusive and unknown fields fail only active thresholds', () => {
  const both = filterByRating(rows, { minRating: 4.5, minReviewCount: 10 });
  assert.deepEqual(both.searchResults.map(r => r.id), ['boundary']);
  assert.equal(both.ratingFilter.excludedResults, 5);
  assert.equal(both.ratingFilter.missingRatingExcluded, 2);
  assert.equal(both.ratingFilter.missingReviewCountExcluded, 2);
  assert.deepEqual(filterByRating(rows, { minRating: 4.5 }).searchResults.map(r => r.id), ['boundary', 'few', 'unknown-count']);
  assert.deepEqual(filterByRating(rows, { minReviewCount: 10 }).searchResults.map(r => r.id), ['boundary', 'low', 'unknown-rating']);
  assert.deepEqual(filterByRating(rows, {}).searchResults, rows);
  assert.deepEqual(filterByRating(rows, { minRating: 0, minReviewCount: 0 }).searchResults, rows);
  assert.equal(filterByRating(rows, { minRating: 0, minReviewCount: 0 }).ratingFilter.applied, false);
});

test('empty filtered pages explicitly report local exclusions without implying no inventory', () => {
  const result = filterByRating(rows, { minReviewCount: 1000 });
  assert.deepEqual(result.searchResults, []);
  assert.equal(result.ratingFilter.execution, 'local');
  assert.equal(result.ratingFilter.examinedResults, 6);
  assert.equal(result.ratingFilter.excludedResults, 6);
  assert.match(result.ratingFilter.note, /cursor/);
});

test('invalid thresholds are rejected rather than coerced', () => {
  for (const minRating of [-1, 5.1, NaN, Infinity, '4.5', true, null, [], {}]) assert.throws(() => validateRatingOptions({ minRating }), /minRating/);
  for (const minReviewCount of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', true, null, [], {}]) assert.throws(() => validateRatingOptions({ minReviewCount }), /minReviewCount/);
});

test('partial-stay discovery aggregates page reports and filters before result caps or deduplication', async () => {
  const options = { minRating: 4.5, minReviewCount: 10 };
  const requested = { checkin: '2027-01-01', checkout: '2027-01-05' };
  const make = (checkin, checkout, rating, id) => {
    const pricing = { checkin, checkout, currency: 'USD', datesMatchPrice: true };
    return { id, pricing, rating, reviewCount: 20, availability: describeAvailability(pricing, { checkin, checkout }) };
  };
  const primary = { ...filterByRating([make(requested.checkin, requested.checkout, 4.6, 'full')], options), paginationInfo: { pageCursors: ['first', 'next'] } };
  const result = await discoverPartialStays(primary, new URL('https://www.airbnb.com/s/Boston/homes'), { ...requested, maxPartialSearches: 2 }, async url => {
    const checkin = url.searchParams.get('checkin'), checkout = url.searchParams.get('checkout');
    return { ...filterByRating([make(checkin, checkout, 4, 'bad'), make(checkin, checkout, 4.5, 'good')], options), paginationInfo: { pageCursors: ['short-first', 'short-next'] } };
  });
  assert.ok(result.searchResults.every(r => r.rating >= 4.5 && r.reviewCount >= 10));
  assert.equal(result.partialStayDiscovery.addedResults, 2);
  assert.equal(result.ratingFilter.scope, 'all_fetched_pages');
  assert.equal(result.ratingFilter.pagesExamined, 3);
  assert.equal(result.ratingFilter.examinedResults, 5);
  assert.equal(result.ratingFilter.excludedResults, 2);
  assert.equal(result.partialStayDiscovery.searches[0].ratingFilter.excludedResults, 1);
  assert.deepEqual(result.paginationInfo.pageCursors, ['first', 'next']);
  assert.deepEqual(result.partialStayDiscovery.searches[0].paginationInfo.pageCursors, ['short-first', 'short-next']);
});

test('live rating thresholds apply to main and partial searches and preserve pagination', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 120000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'rating-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    transport.stderr.on('data', () => {});
    const call = async args => {
      const result = await client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', adults: 2, currency: 'USD', ...args } });
      assert.equal(result.isError, false, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const baseline = await call({});
    assert.ok(baseline.searchResults.length > 0);
    assert.equal(baseline.ratingFilter.applied, false);
    for (const row of baseline.searchResults) {
      assert.ok(row.rating === null || (typeof row.rating === 'number' && row.rating >= 0 && row.rating <= 5));
      assert.ok(row.reviewCount === null || Number.isSafeInteger(row.reviewCount));
    }
    const checkin = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 74 * 86400000).toISOString().slice(0, 10);
    const filtered = await call({ checkin, checkout, minRating: 4.5, minReviewCount: 10, discoverPartialStays: true, maxPartialSearches: 2 });
    assert.ok(filtered.searchResults.length > 0);
    assert.ok(filtered.searchResults.every(row => row.rating >= 4.5 && row.reviewCount >= 10));
    assert.equal(filtered.ratingFilter.pagesExamined, 3);
    for (const window of filtered.partialStayDiscovery.searches) {
      assert.equal(window.ratingFilter.minRating, 4.5);
      assert.equal(window.ratingFilter.minReviewCount, 10);
    }
    const empty = await call({ minReviewCount: Number.MAX_SAFE_INTEGER });
    assert.equal(empty.searchResults.length, 0);
    assert.ok(empty.ratingFilter.examinedResults > 0);
    assert.equal(empty.ratingFilter.excludedResults, empty.ratingFilter.examinedResults);
    assert.ok(empty.paginationInfo.pageCursors.length > 1, 'Empty filtered page must retain later-page cursors');
    console.log(`Live ratings: ${filtered.searchResults.length} qualifying full/partial options; empty filtered page retained ${empty.paginationInfo.pageCursors.length} cursors.`);
  } finally { await client.close(); }
});
