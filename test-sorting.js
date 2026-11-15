import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortSearchResults, validateSortOptions } from './dist/sorting.js';
import { paginateSearch } from './dist/pagination.js';
import { discoverPartialStays } from './dist/partial-stays.js';

const ids = result => result.searchResults.map(row => row.id);
const dated = { checkin: '2027-01-01', checkout: '2027-01-05' };
const row = (id, amount, extra = {}) => ({ id, rating: 4.5, reviewCount: 10,
  pricing: { ...dated, currency: 'USD', stayTotal: amount * 4, averageNightlyTotal: amount, baseNightlyRate: 1, datesMatchPrice: true },
  availability: { matchType: 'exact_dates', coveredRequestedNights: 4 }, ...extra });

test('recommended sorting and omission preserve the existing order without mutating inputs', () => {
  const rows = [row('expensive', 200), row('cheap', 100)];
  Object.freeze(rows);
  for (const options of [{}, { sortBy: 'recommended' }]) {
    const result = sortSearchResults(rows, options);
    assert.deepEqual(ids(result), ['expensive', 'cheap']);
    assert.equal(result.sorting.applied, false);
    assert.equal(result.sorting.sortOrder, null);
  }
  assert.deepEqual(ids(sortSearchResults(rows, { sortBy: 'nightly_price' })), ['cheap', 'expensive']);
  assert.deepEqual(rows.map(row => row.id), ['expensive', 'cheap']);
});

test('rating, review count and coverage default descending and support ascending', () => {
  const rows = [row('a', 10, { rating: 4, reviewCount: 30, availability: { coveredRequestedNights: 2 } }),
    row('b', 10, { rating: 5, reviewCount: 20, availability: { coveredRequestedNights: 4 } })];
  for (const [sortBy, expected] of [['rating', ['b', 'a']], ['review_count', ['a', 'b']], ['nights_covered', ['b', 'a']]]) {
    assert.deepEqual(ids(sortSearchResults(rows, { ...dated, sortBy })), expected);
    assert.deepEqual(ids(sortSearchResults(rows, { ...dated, sortBy, sortOrder: 'asc' })), [...expected].reverse());
  }
});

test('unknown or unusable values sort last in either direction and ties are stable', () => {
  const rows = [{ id: 'missing' }, { id: 'null', rating: null }, { id: 'a', rating: 4.5 },
    { id: 'b', rating: 4.5 }, { id: 'bad', rating: NaN }, { id: 'negative', rating: -1 }, { id: 'string', rating: '5' }];
  for (const sortOrder of ['asc', 'desc']) {
    const result = sortSearchResults(rows, { sortBy: 'rating', sortOrder });
    assert.deepEqual(ids(result), ['a', 'b', 'missing', 'null', 'bad', 'negative', 'string']);
    assert.equal(result.sorting.unrankedResults, 5);
  }
});

test('nightly sorting uses average quoted totals without falling back to base or displayed rates', () => {
  const rows = [row('b', 200), row('a', 100), row('base-only', 1, { pricing: { currency: 'USD', baseNightlyRate: 1, displayedNightlyRate: 1 } }),
    row('mismatch', 1, { pricing: { currency: 'USD', averageNightlyTotal: 1, datesMatchPrice: false } })];
  assert.deepEqual(ids(sortSearchResults(rows, { sortBy: 'nightly_price' })), ['a', 'b', 'base-only', 'mismatch']);
  assert.deepEqual(ids(sortSearchResults(rows, { sortBy: 'nightly_price', sortOrder: 'desc' })), ['b', 'a', 'base-only', 'mismatch']);
});

test('price sorting groups currencies without conversion and puts unknown currencies last', () => {
  const eur = row('eur', 1); eur.pricing.currency = 'EUR';
  const unknown = row('unknown', 0); unknown.pricing.currency = null;
  const result = sortSearchResults([row('usd-high', 100), eur, unknown, row('usd-low', 50)], { sortBy: 'nightly_price' });
  assert.deepEqual(ids(result), ['usd-low', 'usd-high', 'eur', 'unknown']);
  assert.deepEqual(result.sorting.groups, [{ currency: 'USD', results: 2 }, { currency: 'EUR', results: 1 }]);
});

test('stay totals compare only identical quoted dates, with unverified dates last', () => {
  const short = row('short', 1); short.pricing.checkout = '2027-01-03';
  const alternative = row('alternative', 1); alternative.pricing.checkin = '2027-01-02'; alternative.pricing.checkout = '2027-01-06';
  const unknown = row('unknown', 1); unknown.pricing.datesMatchPrice = null;
  const result = sortSearchResults([row('high', 100), short, row('low', 50), alternative, unknown], { sortBy: 'total_price' });
  assert.deepEqual(ids(result), ['low', 'high', 'short', 'alternative', 'unknown']);
  assert.equal(result.sorting.groups.length, 3);
  assert.equal(result.sorting.priceBasis, 'stayTotal');
  assert.equal(result.sorting.unrankedResults, 1);
});

test('sort validation rejects unsupported/coerced options and coverage without dates', () => {
  for (const sortBy of ['price', '', null, true, [], 1]) assert.throws(() => validateSortOptions({ sortBy }), /sortBy/);
  for (const sortOrder of ['ascending', '', null, true, 1]) assert.throws(() => validateSortOptions({ sortBy: 'rating', sortOrder }), /sortOrder/);
  assert.throws(() => validateSortOptions({ sortOrder: 'asc' }), /requires/);
  assert.throws(() => validateSortOptions({ sortBy: 'recommended', sortOrder: 'asc' }), /requires/);
  assert.throws(() => validateSortOptions({ sortBy: 'nights_covered' }), /requires valid/);
  validateSortOptions({ ...dated, sortBy: 'nights_covered' });
});

test('sorting the combined result includes later pages and discovered stays without changing cursors or counts', async () => {
  const page = rows => ({ searchResults: rows, paginationInfo: { pageCursors: ['first', 'second', 'third'] } });
  const url = new URL('https://www.airbnb.com/s/Boston/homes');
  const paginated = await paginateSearch(page([row('first', 300)]), url, { targetResults: 2 }, async () => page([row('second', 200)]));
  const short = row('partial', 100); short.pricing.checkout = '2027-01-04';
  const discovered = await discoverPartialStays(paginated, url, { ...dated, maxPartialSearches: 1 }, async () => page([short]));
  const result = { ...discovered, ...sortSearchResults(discovered.searchResults, { sortBy: 'nightly_price' }) };
  assert.deepEqual(ids(result), ['partial', 'second', 'first']);
  assert.equal(result.searchResults[0].availability.matchType, 'partial_stay');
  assert.equal(result.autoPagination.nextCursor, 'third');
  assert.equal(result.autoPagination.returnedResults, 2);
  assert.equal(result.partialStayDiscovery.addedResults, 1);
  assert.equal(result.sorting.resultsConsidered, 3);
  assert.equal(result.sorting.scope, 'fetched_results');
});

test('live sorting orders combined pages and partial stays', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 120000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'sorting-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    transport.stderr.on('data', () => {});
    const checkin = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 74 * 86400000).toISOString().slice(0, 10);
    const call = async extra => {
      const response = await client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', checkin, checkout, adults: 2, currency: 'USD', targetResults: 100, maxPages: 2, ...extra } });
      assert.equal(response.isError, false, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    const prices = await call({ sortBy: 'nightly_price' });
    assert.equal(prices.autoPagination.pagesFetched, 2);
    assert.ok(prices.searchResults.length > 1);
    assert.equal(prices.sorting.sortOrder, 'asc');
    assert.equal(prices.sorting.scope, 'fetched_results');
    assert.equal(prices.sorting.groups.length, 1);
    assert.equal(prices.sorting.groups[0].currency, 'USD');
    const ranked = prices.searchResults.slice(0, prices.searchResults.length - prices.sorting.unrankedResults);
    assert.ok(ranked.length > 1);
    for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].pricing.averageNightlyTotal <= ranked[i].pricing.averageNightlyTotal);
    assert.ok(prices.autoPagination.nextCursor);
    const ratings = await call({ sortBy: 'rating', discoverPartialStays: true, maxPartialSearches: 1 });
    assert.equal(ratings.autoPagination.pagesFetched, 2);
    assert.equal(ratings.partialStayDiscovery.completedSearches, 1);
    assert.equal(ratings.sorting.resultsConsidered, ratings.searchResults.length);
    const values = ratings.searchResults.map(row => row.rating);
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] === null) assert.equal(values[i], null);
      else if (values[i] !== null) assert.ok(values[i - 1] >= values[i]);
    }
    console.log(`Live sorting: ${prices.searchResults.length} price-sorted options; ${ratings.searchResults.length} rating-sorted full/partial options.`);
  } finally { await client.close(); }
});
