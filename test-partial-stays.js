import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeAvailability } from './dist/availability.js';
import { dateNights } from './dist/pricing.js';
import { planPartialStays, partialSearchUrl, discoverPartialStays, validatePartialOptions, MAX_PARTIAL_RESULTS } from './dist/partial-stays.js';

const requested = { checkin: '2027-01-01', checkout: '2027-01-05' };
const primaryUrl = new URL('https://www.airbnb.com/s/Boston/homes?checkin=2027-01-01&checkout=2027-01-05&adults=2&children=1&infants=1&pets=1&currency=EUR&amenities[]=4&amenities[]=8&min_bedrooms=2&min_bathrooms=1&min_beds=3&room_types[]=Entire+home%2Fapt&price_min=100&price_max=500&price_filter_input_type=0&ne_lat=43&ne_lng=-70&sw_lat=42&sw_lng=-71&cursor=old&flexible_date_search_filter_type=3');
function row(id, checkin, checkout, currency = 'EUR') {
  const pricing = { checkin, checkout, nights: dateNights(checkin, checkout), datesMatchPrice: true, currency, stayTotal: 300 };
  return { id, pricing, url: `https://www.airbnb.com/rooms/${id}?check_in=${checkin}&check_out=${checkout}`, availability: describeAvailability(pricing, { checkin, checkout }) };
}
const full = row('full', requested.checkin, requested.checkout);
const page = rows => ({ searchResults: rows, paginationInfo: { nextPageCursor: 'next' }, availabilityFilter: { applied: true, excludedResults: 2 } });

test('plans every shorter window longest-first within a small stay, including interior stays', () => {
  const plan = planPartialStays(requested.checkin, requested.checkout);
  assert.equal(plan.candidateWindows, 5);
  assert.deepEqual(plan.windows, [
    { checkin: '2027-01-01', checkout: '2027-01-04', nights: 3 },
    { checkin: '2027-01-02', checkout: '2027-01-05', nights: 3 },
    { checkin: '2027-01-01', checkout: '2027-01-03', nights: 2 },
    { checkin: '2027-01-03', checkout: '2027-01-05', nights: 2 },
    { checkin: '2027-01-02', checkout: '2027-01-04', nights: 2 },
  ]);
  assert.equal(planPartialStays('2027-01-01', '2027-01-03').windows.length, 0);
  assert.equal(planPartialStays('2027-01-01', '2027-01-03', 1).windows.length, 2);
});

test('planning is bounded for long ranges and uses calendar days across DST and years', () => {
  for (const dates of [['2026-12-30', '2027-01-03'], ['2027-03-12', '2027-03-16']]) {
    const plan = planPartialStays(...dates, 1, 8);
    assert.equal(new Set(plan.windows.map(w => `${w.checkin}/${w.checkout}`)).size, plan.windows.length);
    assert.ok(plan.windows.every(w => dateNights(w.checkin, w.checkout) === w.nights && w.checkin >= dates[0] && w.checkout <= dates[1]));
  }
  const long = planPartialStays('2027-01-01', '2037-01-01', 1, 8);
  assert.equal(long.windows.length, 8);
  assert.ok(long.candidateWindows > 1000000);
});

test('partial URLs preserve every guest/filter/bounding-box parameter and clear flexibility/cursor', () => {
  const window = planPartialStays(requested.checkin, requested.checkout).windows[0];
  const url = partialSearchUrl(primaryUrl, window);
  assert.equal(url.pathname, primaryUrl.pathname);
  assert.equal(url.searchParams.get('checkin'), window.checkin);
  assert.equal(url.searchParams.get('checkout'), window.checkout);
  assert.equal(url.searchParams.has('cursor'), false);
  assert.equal(url.searchParams.has('flexible_date_search_filter_type'), false);
  for (const key of new Set(primaryUrl.searchParams.keys())) {
    if (['checkin', 'checkout', 'cursor', 'flexible_date_search_filter_type'].includes(key)) continue;
    assert.deepEqual(url.searchParams.getAll(key), primaryUrl.searchParams.getAll(key), key);
  }
  assert.equal(primaryUrl.searchParams.get('cursor'), 'old', 'Must not mutate the main search');
});

test('discovery labels against original dates, deduplicates quotes, and preserves distinct stays', async () => {
  const shorter = row('new', '2027-01-01', '2027-01-04');
  const differentStay = row('new', '2027-01-02', '2027-01-05');
  const badPrice = { ...row('bad', '2027-01-01', '2027-01-04'), pricing: { ...shorter.pricing, datesMatchPrice: false } };
  const result = await discoverPartialStays(page([full]), primaryUrl, { ...requested, maxPartialSearches: 2 }, async () => page([
    shorter, shorter, differentStay, row('full', '2027-01-01', '2027-01-04'),
    row('outside', '2026-12-31', '2027-01-03'), row('too-short', '2027-01-01', '2027-01-02'),
    badPrice, { ...badPrice, id: 'unknown', pricing: { ...badPrice.pricing, datesMatchPrice: null } },
  ]));
  assert.equal(result.searchResults.length, 3);
  assert.equal(result.searchResults[0], full);
  assert.equal(result.partialStayDiscovery.addedResults, 2);
  assert.equal(result.partialStayDiscovery.suppressedFullStayResults, 2);
  for (const option of result.searchResults.slice(1)) {
    assert.equal(option.availability.matchType, 'partial_stay');
    assert.match(option.availability.label, /Partial stay: 3 of 4 requested nights/);
    assert.equal(option.availability.missingRequestedNights, 1);
    assert.equal(option.pricing.stayTotal, 300);
    assert.equal(new URL(option.url).searchParams.get('check_in'), option.pricing.checkin);
  }
  assert.equal(shorter.availability.matchType, 'exact_dates', 'Must not mutate input rows');
  assert.equal(result.paginationInfo.nextPageCursor, 'next');
  assert.equal(result.partialStayDiscovery.searches[0].paginationInfo.nextPageCursor, 'next');
  assert.equal(result.partialStayDiscovery.unsearchedWindows, 3);
  assert.equal(result.partialStayDiscovery.allWindowsSearched, false);
});

test('failed windows keep successful partial results and the primary results', async () => {
  let calls = 0;
  const result = await discoverPartialStays(page([full]), primaryUrl, requested, async url => {
    if (++calls === 1) throw new Error('HTTP 503');
    return page([row('partial', url.searchParams.get('checkin'), url.searchParams.get('checkout'))]);
  });
  assert.equal(result.searchResults[0], full);
  assert.equal(result.partialStayDiscovery.failedSearches, 1);
  assert.equal(result.partialStayDiscovery.completedSearches, 4);
  assert.equal(result.partialStayDiscovery.unsearchedWindows, 1);
  assert.match(result.partialStayDiscovery.searches[0].error, /503/);
  assert.equal(result.partialStayDiscovery.addedResults, 4);
});

test('discovery works with an empty primary page without claiming exhaustive inventory', async () => {
  const result = await discoverPartialStays(page([]), primaryUrl, requested, async url => page([row('partial', url.searchParams.get('checkin'), url.searchParams.get('checkout'))]));
  assert.equal(result.searchResults.length, 5);
  assert.equal(result.partialStayDiscovery.allWindowsSearched, true);
  assert.equal(result.partialStayDiscovery.resultsLimitedToFirstPage, true);
  assert.equal(result.partialStayDiscovery.unsearchedWindows, 0);
});

test('extra requests have bounded concurrency and per-window timeouts', async () => {
  let active = 0, peak = 0;
  const result = await discoverPartialStays(page([]), primaryUrl, requested, async (_url, timeoutMs) => {
    active++; peak = Math.max(peak, active);
    assert.ok(timeoutMs > 0 && timeoutMs <= 8000);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return page([]);
  });
  assert.equal(peak, 2);
  assert.equal(result.partialStayDiscovery.completedSearches, 5);
});

test('time budget leaves remaining windows explicitly unchecked', async () => {
  let clock = 0;
  const result = await discoverPartialStays(page([full]), primaryUrl, requested, async () => {
    clock = 20001;
    return page([]);
  }, () => clock);
  assert.equal(result.partialStayDiscovery.completedSearches, 1);
  assert.equal(result.partialStayDiscovery.skippedSearches, 4);
  assert.equal(result.partialStayDiscovery.unsearchedWindows, 4);
  assert.match(result.partialStayDiscovery.searches[1].error, /budget/);
});

test('result cap is explicit and does not truncate primary results', async () => {
  const result = await discoverPartialStays(page([full]), primaryUrl, { ...requested, maxPartialSearches: 1 }, async () => page(
    Array.from({ length: MAX_PARTIAL_RESULTS + 5 }, (_, i) => row(String(i), '2027-01-01', '2027-01-04'))
  ));
  assert.equal(result.searchResults.length, MAX_PARTIAL_RESULTS + 1);
  assert.equal(result.partialStayDiscovery.omittedResults, 5);
  assert.equal(result.partialStayDiscovery.addedResults, MAX_PARTIAL_RESULTS);
});

test('validation rejects unbounded, ambiguous and undated discovery requests', () => {
  for (const args of [
    { discoverPartialStays: null }, { discoverPartialStays: 'true' },
    { discoverPartialStays: true }, { discoverPartialStays: true, ...requested, cursor: 'next' },
    { minPartialNights: 2 }, { maxPartialSearches: 3 },
    ...[0, 9, -1, 1.5, '3', null, true].map(maxPartialSearches => ({ discoverPartialStays: true, ...requested, maxPartialSearches })),
    ...[0, -1, 1.5, '2', null, true].map(minPartialNights => ({ discoverPartialStays: true, ...requested, minPartialNights })),
  ]) assert.throws(() => validatePartialOptions(args), undefined, JSON.stringify(args));
});

test('live partial-stay toggle preserves full results and discovers labeled shorter quotes', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 90000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'partial-stay-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
  let logs = '';
  try {
    await client.connect(transport);
    transport.stderr.on('data', chunk => { logs += chunk; });
    const checkin = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 74 * 86400000).toISOString().slice(0, 10);
    const params = { location: 'Boston, MA', checkin, checkout, adults: 2, currency: 'USD', minBeds: 1, amenities: ['wifi'] };
    const off = await client.callTool({ name: 'airbnb_search', arguments: params });
    assert.equal(off.isError, false, JSON.stringify(off));
    const offData = JSON.parse(off.content[0].text);
    assert.equal(offData.partialStayDiscovery, undefined);
    assert.ok(offData.searchResults.every(r => r.availability.matchType !== 'partial_stay'));
    const before = (logs.match(/Performing Airbnb search/g) ?? []).length;
    const on = await client.callTool({ name: 'airbnb_search', arguments: { ...params, discoverPartialStays: true, maxPartialSearches: 3 } });
    assert.equal(on.isError, false, JSON.stringify(on));
    const data = JSON.parse(on.content[0].text);
    assert.equal(data.partialStayDiscovery.completedSearches, 3, JSON.stringify(data.partialStayDiscovery));
    assert.equal((logs.match(/Performing Airbnb search/g) ?? []).length - before, 4, 'One main search and exactly three extra searches');
    for (const row of data.searchResults.filter(r => r.discovery)) {
      assert.equal(row.availability.matchType, 'partial_stay');
      assert.ok(row.pricing.checkin >= checkin && row.pricing.checkout <= checkout);
      assert.ok(row.pricing.nights >= 2 && row.pricing.nights < 4);
      assert.equal(row.availability.requestedNights, 4);
      assert.equal(row.pricing.datesMatchPrice, true);
      assert.equal(new URL(row.url).searchParams.get('check_in'), row.pricing.checkin);
      assert.equal(new URL(row.url).searchParams.get('check_out'), row.pricing.checkout);
    }
    console.log(`Live toggle: ${offData.searchResults.length} main results with discovery off; ${data.partialStayDiscovery.addedResults} shorter-stay quotes added with discovery on.`);
  } finally { await client.close(); }
});
