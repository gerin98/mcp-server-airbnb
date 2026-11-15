import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginateSearch, validatePaginationOptions, PAGINATION_BUDGET_MS } from './dist/pagination.js';
import { filterByRating } from './dist/ratings.js';
import { discoverPartialStays } from './dist/partial-stays.js';

const url = new URL('https://www.airbnb.com/s/Boston/homes?adults=2&currency=USD&amenities%5B%5D=4&ne_lat=42&checkin=2027-01-01&checkout=2027-01-05');
const row = (id, checkin = '2027-01-01', checkout = '2027-01-05') => ({ id, rating: 4.8, reviewCount: 20,
  pricing: { checkin, checkout, currency: 'USD', datesMatchPrice: true }, availability: { matchType: 'exact_dates' } });
const page = (rows, cursors = ['first', 'second', 'third']) => ({ ...filterByRating(rows, { minRating: 4.5 }),
  paginationInfo: { pageCursors: cursors }, availabilityFilter: { applied: true, excludedResults: 1, partialStayResults: 0 } });

test('pagination validates bounded options and requires a target', () => {
  for (const targetResults of [0, -1, 101, 1.5, '10', null, true]) assert.throws(() => validatePaginationOptions({ targetResults }), /targetResults/);
  for (const maxPages of [0, 6, 1.5, '2', null, true]) assert.throws(() => validatePaginationOptions({ targetResults: 10, maxPages }), /maxPages/);
  assert.throws(() => validatePaginationOptions({ maxPages: 2 }), /requires/);
  for (const cursor of ['', ' ', null, 1]) assert.throws(() => validatePaginationOptions({ cursor }), /cursor/);
  validatePaginationOptions({});
  validatePaginationOptions({ targetResults: 100, maxPages: 5, cursor: 'second' });
});

test('pagination preserves all URL filters, deduplicates stays and returns whole pages', async () => {
  const result = await paginateSearch(page([row('a')]), url, { targetResults: 2 }, async (next, timeout) => {
    const expected = new URL(url); expected.searchParams.set('cursor', 'second');
    assert.equal(next.toString(), expected.toString());
    assert.ok(timeout > 0 && timeout <= 8000);
    return page([row('a'), row('b'), row('c')]);
  });
  assert.deepEqual(result.searchResults.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(result.autoPagination.duplicatesRemoved, 1);
  assert.equal(result.autoPagination.stopReason, 'target_reached');
  assert.equal(result.autoPagination.nextCursor, 'third');
  assert.equal(result.ratingFilter.examinedResults, 4);
  assert.equal(result.ratingFilter.pagesExamined, 2);
  assert.equal(result.availabilityFilter.excludedResults, 2);
});

test('empty filtered pages and duplicate pages do not prevent reaching later matches', async () => {
  let calls = 0;
  const result = await paginateSearch(page([]), url, { targetResults: 2 }, async () => {
    calls++; return page(calls === 1 ? [] : [row('a'), row('a', '2027-01-02')]);
  });
  assert.equal(calls, 2);
  assert.equal(result.searchResults.length, 2);
  assert.equal(result.autoPagination.nextCursor, null);
  assert.equal(result.autoPagination.targetReached, true);
});

test('resuming from a cursor starts after that page and uses the latest provider cursor list', async () => {
  const resumed = new URL(url); resumed.searchParams.set('cursor', 'second');
  const result = await paginateSearch(page([row('a')]), resumed, { targetResults: 3 }, async next => {
    assert.equal(next.searchParams.get('cursor'), 'third');
    return page([row('b')], ['first', 'second', 'third']);
  });
  assert.equal(result.autoPagination.stopReason, 'no_more_cursors');
  assert.equal(result.autoPagination.pagesFetched, 2);
  assert.equal(result.autoPagination.targetReached, false);
});

test('target and page limits avoid unnecessary requests and preserve continuation', async () => {
  for (const [options, reason] of [[{ targetResults: 1 }, 'target_reached'], [{ targetResults: 10, maxPages: 1 }, 'page_limit']]) {
    const result = await paginateSearch(page([row('a')]), url, options, async () => { throw new Error('Unexpected fetch'); });
    assert.equal(result.autoPagination.stopReason, reason);
    assert.equal(result.autoPagination.pagesFetched, 1);
    assert.equal(result.autoPagination.nextCursor, 'second');
  }
});

test('missing, unrecognized and looping cursors stop safely', async () => {
  for (const [info, cursor, reason] of [[{}, null, 'pagination_unavailable'], [{ pageCursors: ['first'] }, 'missing', 'cursor_unrecognized'], [{ pageCursors: ['first', 'first'] }, null, 'repeated_cursor']]) {
    const start = new URL(url); if (cursor) start.searchParams.set('cursor', cursor);
    const result = await paginateSearch({ ...page([]), paginationInfo: info }, start, { targetResults: 5 }, async () => { throw new Error('Unexpected fetch'); });
    assert.equal(result.autoPagination.stopReason, reason);
    assert.equal(result.autoPagination.nextCursor, null);
  }
});

test('failed pages preserve prior results and retain the failed cursor for retry', async () => {
  const result = await paginateSearch(page([row('a')]), url, { targetResults: 5 }, async () => { throw new Error('Provider unavailable'); });
  assert.equal(result.searchResults.length, 1);
  assert.equal(result.autoPagination.stopReason, 'page_failed');
  assert.equal(result.autoPagination.nextCursor, 'second');
  assert.equal(result.autoPagination.pagesFetched, 1);
  assert.equal(result.autoPagination.pagesAttempted, 2);
  assert.match(result.autoPagination.error, /Provider unavailable/);
});

test('shared time budget stops new requests and supplies remaining time to the fetch', async () => {
  let time = 0;
  const result = await paginateSearch(page([]), url, { targetResults: 5 }, async () => {
    time = PAGINATION_BUDGET_MS;
    return page([row('a')]);
  }, () => time);
  assert.equal(result.autoPagination.stopReason, 'time_limit');
  assert.equal(result.autoPagination.nextCursor, 'third');
  let ticks = 0;
  await paginateSearch(page([]), url, { targetResults: 1 }, async (_, timeout) => {
    assert.equal(timeout, 500); return page([row('a')]);
  }, () => ticks++ === 0 ? 0 : PAGINATION_BUDGET_MS - 500);
});

test('partial discovery follows paginated main results and suppresses shorter versions of full stays', async () => {
  const primary = await paginateSearch(page([row('a')]), url, { targetResults: 2 }, async () => page([row('b')]));
  const result = await discoverPartialStays(primary, url, { checkin: '2027-01-01', checkout: '2027-01-05', maxPartialSearches: 1 }, async () => page([row('b', '2027-01-01', '2027-01-04'), row('c', '2027-01-01', '2027-01-04')]));
  assert.deepEqual(result.searchResults.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(result.partialStayDiscovery.suppressedFullStayResults, 1);
  assert.equal(result.ratingFilter.pagesExamined, 3);
  assert.equal(result.availabilityFilter.excludedResultsScope, 'primary_search_pages');
  assert.equal(result.autoPagination.returnedResults, 2);
  assert.equal(result.autoPagination.nextCursor, 'third');
});

test('live automatic pagination preserves filters, cursor continuation and empty pages', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 120000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'pagination-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    transport.stderr.on('data', () => {});
    const checkin = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 74 * 86400000).toISOString().slice(0, 10);
    const args = { location: 'Boston, MA', checkin, checkout, adults: 2, currency: 'USD', minRating: 4.5, minReviewCount: 10, targetResults: 100, maxPages: 2 };
    const call = async extra => {
      const response = await client.callTool({ name: 'airbnb_search', arguments: { ...args, ...extra } });
      assert.equal(response.isError, false, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    const result = await call({});
    assert.equal(result.autoPagination.pagesFetched, 2);
    assert.equal(result.autoPagination.stopReason, 'page_limit');
    assert.ok(result.searchResults.length > 0);
    assert.ok(result.searchResults.every(r => r.rating >= 4.5 && r.reviewCount >= 10));
    assert.ok(result.searchResults.every(r => r.availability.matchType === 'exact_dates'));
    assert.ok(result.autoPagination.pages[1].addedResults > 0);
    assert.equal(new Set(result.searchResults.map(r => JSON.stringify([r.id, r.pricing.checkin, r.pricing.checkout, r.pricing.currency]))).size, result.searchResults.length);
    const resumed = await call({ cursor: result.autoPagination.nextCursor, maxPages: 1 });
    assert.equal(resumed.autoPagination.pages[0].cursor, result.autoPagination.nextCursor);
    assert.equal(resumed.autoPagination.pagesFetched, 1);
    const empty = await call({ minReviewCount: Number.MAX_SAFE_INTEGER });
    assert.equal(empty.searchResults.length, 0);
    assert.equal(empty.autoPagination.pagesFetched, 2);
    assert.ok(empty.autoPagination.nextCursor);
    assert.equal(empty.ratingFilter.pagesExamined, 2);
    console.log(`Live pagination: ${result.searchResults.length} unique qualifying results across two pages; resume and empty-page continuation passed.`);
  } finally { await client.close(); }
});
