import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterByTotalPrice, validateTotalPriceOptions } from './dist/total-price.js';
import { filterByRating } from './dist/ratings.js';
import { paginateSearch } from './dist/pagination.js';
import { discoverPartialStays } from './dist/partial-stays.js';
import { sortSearchResults } from './dist/sorting.js';

const dates = { checkin: '2027-01-01', checkout: '2027-01-05' };
const options = { maxTotalPrice: 1500, currency: 'USD' };
const row = (id, amount, extra = {}) => ({ id, rating: 4.8, reviewCount: 20,
  pricing: { ...dates, stayTotal: amount, currency: 'USD', datesMatchPrice: true, ...extra },
  availability: { matchType: 'exact_dates' } });
const ids = result => result.searchResults.map(row => row.id);

test('total budget is inclusive, permits decimal amounts and treats zero as a zero cap', () => {
  const rows = [row('zero', 0), row('below', 1499.99), row('boundary', 1500), row('over', 1500.01)];
  const result = filterByTotalPrice(rows, options);
  assert.deepEqual(ids(result), ['zero', 'below', 'boundary']);
  assert.equal(result.totalPriceFilter.overBudgetExcluded, 1);
  assert.deepEqual(ids(filterByTotalPrice(rows, { ...options, maxTotalPrice: 1499.99 })), ['zero', 'below']);
  assert.deepEqual(ids(filterByTotalPrice(rows, { ...options, maxTotalPrice: 0 })), ['zero']);
  assert.equal(filterByTotalPrice(rows, { ...options, maxTotalPrice: 0 }).totalPriceFilter.applied, true);
});

test('omitting a total cap preserves all results including unknown prices', () => {
  const rows = [row('expensive', 9999), { id: 'unknown' }];
  const result = filterByTotalPrice(rows, {});
  assert.deepEqual(result.searchResults, rows);
  assert.equal(result.totalPriceFilter.applied, false);
  assert.equal(result.totalPriceFilter.excludedResults, 0);
});

test('unknown, malformed and mismatched totals or currencies never qualify', () => {
  const rows = [row('null', null), row('missing', undefined), row('negative', -1), row('infinite', Infinity), row('string', '100'),
    row('unknown-currency', 100, { currency: null }), row('invalid-currency', 100, { currency: '$' }), row('eur', 100, { currency: 'EUR' }),
    row('unknown-dates', 100, { checkin: null, checkout: null }), row('bad-dates', 100, { checkout: '2027-01-01' }),
    row('mismatched-dates', 100, { datesMatchPrice: false }), row('unverified-dates', 100, { datesMatchPrice: null })];
  const result = filterByTotalPrice(rows, options);
  assert.deepEqual(result.searchResults, []);
  assert.equal(result.totalPriceFilter.unknownTotalExcluded, 5);
  assert.equal(result.totalPriceFilter.unknownCurrencyExcluded, 2);
  assert.equal(result.totalPriceFilter.currencyMismatchExcluded, 1);
  assert.equal(result.totalPriceFilter.unverifiedDatesExcluded, 4);
  assert.equal(result.totalPriceFilter.excludedResults, 12);
});

test('the filter uses the quoted total without inventing fees or estimating from nightly prices', () => {
  const included = row('approximate', 1200, { stayTotalIsApproximate: true, taxesIncluded: false, feesIncluded: null, baseNightlyRate: 1, averageNightlyTotal: 300 });
  Object.freeze(included.pricing);
  const result = filterByTotalPrice([included, row('nightly-only', null, { baseNightlyRate: 100, averageNightlyTotal: 100 })], options);
  assert.deepEqual(ids(result), ['approximate']);
  assert.equal(result.searchResults[0], included);
  assert.equal(result.searchResults[0].pricing.taxesIncluded, false);
  assert.equal(result.searchResults[0].pricing.feesIncluded, null);
  assert.match(result.totalPriceFilter.note, /approximate/);
});

test('budget validation requires an explicit currency and rejects unsafe or coerced caps', () => {
  for (const maxTotalPrice of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1500', null, true, [], {}]) assert.throws(() => validateTotalPriceOptions({ currency: 'USD', maxTotalPrice }), /maxTotalPrice/);
  for (const currency of [undefined, null, 'usd', '$', 1, true]) assert.throws(() => validateTotalPriceOptions({ maxTotalPrice: 100, currency }), /requires currency/);
  validateTotalPriceOptions({ maxTotalPrice: 0, currency: 'EUR' });
  validateTotalPriceOptions({});
});

test('budget filtering precedes pagination targets, deduplication and partial discovery, and aggregates reports', async () => {
  const page = rows => {
    const rated = filterByRating(rows, { minRating: 4.5 });
    return { ...rated, ...filterByTotalPrice(rated.searchResults, options), paginationInfo: { pageCursors: ['first', 'second', 'third'] } };
  };
  const url = new URL('https://www.airbnb.com/s/Boston/homes');
  const primary = page([row('expensive', 2000), { ...row('low-rated', 500), rating: 3 }]);
  let calls = 0;
  const paginated = await paginateSearch(primary, url, { targetResults: 1 }, async next => {
    calls++;
    assert.equal(next.searchParams.get('cursor'), 'second');
    return page([row('eligible', 1400), row('over', 1600)]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(ids(paginated), ['eligible']);
  assert.equal(paginated.autoPagination.targetReached, true);
  assert.equal(paginated.autoPagination.nextCursor, 'third');
  assert.equal(paginated.totalPriceFilter.examinedResults, 3);
  assert.equal(paginated.totalPriceFilter.overBudgetExcluded, 2);
  const combined = await discoverPartialStays(paginated, url, { ...dates, maxPartialSearches: 1 }, async () => page([
    row('expensive', 1200, { checkout: '2027-01-04' }), row('partial-over', 1600, { checkout: '2027-01-04' }),
  ]));
  const result = { ...combined, ...sortSearchResults(combined.searchResults, { sortBy: 'rating' }) };
  assert.deepEqual(ids(result), ['eligible', 'expensive']);
  assert.equal(result.searchResults[1].availability.matchType, 'partial_stay');
  assert.equal(result.searchResults[1].availability.coveredRequestedNights, 3);
  assert.equal(result.searchResults[1].pricing.stayTotal, 1200);
  assert.equal(result.totalPriceFilter.pagesExamined, 3);
  assert.equal(result.totalPriceFilter.examinedResults, 5);
  assert.equal(result.totalPriceFilter.overBudgetExcluded, 3);
  assert.equal(result.totalPriceFilter.scope, 'all_fetched_pages');
  assert.equal(result.partialStayDiscovery.searches[0].totalPriceFilter.maxTotalPrice, 1500);
  assert.equal(result.autoPagination.pages[1].totalPriceFilter.overBudgetExcluded, 1);
});

test('failed later pages retain budget reports and the retry cursor', async () => {
  const first = { ...filterByTotalPrice([row('ok', 100), row('over', 2000)], options), paginationInfo: { pageCursors: ['first', 'second'] } };
  const result = await paginateSearch(first, new URL('https://www.airbnb.com/s/Boston/homes'), { targetResults: 5 }, async () => { throw new Error('Unavailable'); });
  assert.deepEqual(ids(result), ['ok']);
  assert.equal(result.totalPriceFilter.pagesExamined, 1);
  assert.equal(result.totalPriceFilter.excludedResults, 1);
  assert.equal(result.autoPagination.nextCursor, 'second');
});

test('live total budget applies across pagination and partial stays, including a zero-budget empty search', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 120000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'total-price-tests', version: '1.0.0' }, { capabilities: {} });
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
    const result = await call({ maxTotalPrice: 1500, minRating: 4.5, sortBy: 'total_price', discoverPartialStays: true, maxPartialSearches: 1 });
    assert.ok(result.searchResults.length > 0);
    assert.equal(result.autoPagination.pagesFetched, 2);
    assert.equal(result.partialStayDiscovery.completedSearches, 1);
    assert.equal(result.totalPriceFilter.pagesExamined, 3);
    assert.equal(result.partialStayDiscovery.searches[0].totalPriceFilter.maxTotalPrice, 1500);
    assert.equal(result.sorting.resultsConsidered, result.searchResults.length);
    for (const item of result.searchResults) {
      assert.ok(item.pricing.stayTotal >= 0 && item.pricing.stayTotal <= 1500);
      assert.equal(item.pricing.currency, 'USD');
      assert.equal(item.pricing.datesMatchPrice, true);
      assert.ok(item.rating >= 4.5);
      assert.ok(Object.hasOwn(item.pricing, 'taxesIncluded'));
      assert.ok(Object.hasOwn(item.pricing, 'feesIncluded'));
      if (item.availability.matchType === 'partial_stay') assert.match(item.availability.label, /Partial stay/);
    }
    const empty = await call({ maxTotalPrice: 0 });
    assert.equal(empty.searchResults.length, 0);
    assert.equal(empty.autoPagination.pagesFetched, 2);
    assert.ok(empty.autoPagination.nextCursor);
    assert.ok(empty.totalPriceFilter.overBudgetExcluded > 0);
    assert.equal(empty.totalPriceFilter.examinedResults, empty.totalPriceFilter.excludedResults);
    console.log(`Live total budget: ${result.searchResults.length} qualifying options; zero-budget search continued across two pages.`);
  } finally { await client.close(); }
});
