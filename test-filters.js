import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'search-filter-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'],
  stderr: 'pipe',
});
let serverLog = '';

before(async () => {
  await client.connect(transport);
  transport.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-8000); });
});
after(async () => { await client.close(); });

test('search advertises optional whole-number room minimums', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  for (const name of ['minBedrooms', 'minBeds', 'minBathrooms']) {
    assert.equal(schema.properties[name].type, 'integer');
    assert.equal(schema.properties[name].minimum, 0);
    assert.ok(!schema.required.includes(name));
  }
});

for (const name of ['minBedrooms', 'minBeds', 'minBathrooms']) {
  test(`${name} rejects invalid values through MCP`, async () => {
    for (const value of [-1, 1.5, '2', null, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        client.callTool({
          name: 'airbnb_search',
          arguments: { location: 'Boston, MA', [name]: value },
        }),
        error => error.code === -32602 && error.message.includes(name),
        `Expected InvalidParams for ${name}=${JSON.stringify(value)}`,
      );
    }
  });
}

test('search advertises supported amenity names', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.amenities.type, 'array');
  assert.equal(schema.properties.amenities.items.type, 'string');
  for (const name of ['wifi', 'kitchen', 'washer', 'pool', 'free_parking']) {
    assert.ok(schema.properties.amenities.items.enum.includes(name));
  }
  assert.ok(!schema.required.includes('amenities'));
});

test('amenity discovery works offline with default configuration and matches search', async () => {
  const catalogClient = new Client({ name: 'catalog-test', version: '1.0.0' }, { capabilities: {} });
  const catalogTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./dist/index.js', import.meta.url))],
    stderr: 'pipe',
  });
  let log = '';
  try {
    const connecting = catalogClient.connect(catalogTransport);
    catalogTransport.stderr.on('data', chunk => { log += chunk; });
    await connecting;
    const { tools } = await catalogClient.listTools();
    assert.ok(tools.some(tool => tool.name === 'airbnb_list_amenities'));
    const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.tools.map(tool => tool.name).sort(), tools.map(tool => tool.name).sort());
    const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
    for (const params of [{ name: 'airbnb_list_amenities' }, { name: 'airbnb_list_amenities', arguments: {} }]) {
      const result = await catalogClient.callTool(params);
      assert.equal(result.isError, false);
      const data = JSON.parse(result.content[0].text);
      const names = data.amenities.map(amenity => amenity.name);
      assert.deepEqual(names.sort(), [...schema.properties.amenities.items.enum].sort());
      assert.equal(new Set(names).size, names.length);
      for (const amenity of data.amenities) {
        assert.ok(amenity.label.trim());
        assert.ok(amenity.description.trim());
      }
      assert.match(data.amenities.find(amenity => amenity.name === 'pool').description, /shared/i);
      assert.match(data.usage, /airbnb_search/);
      assert.match(data.usage, /airbnb_listing_details/);
    }
    await assert.rejects(
      catalogClient.callTool({ name: 'airbnb_list_amenities', arguments: { location: 'Boston, MA' } }),
      error => error.code === -32602,
    );
  } finally {
    await catalogClient.close();
  }
  assert.doesNotMatch(log, /Fetching robots\.txt|Geocoding location|Performing Airbnb search|Fetching listing details/);
});

test('amenities rejects malformed arrays and unsupported names through MCP', async () => {
  for (const value of ['wifi', 4, null, true, {}, [4], [null], [{}], [['wifi']], [''], ['WiFi'], ['unknown'], ['wifi', 'unknown'], ['toString'], ['__proto__']]) {
    await assert.rejects(
      client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', amenities: value } }),
      error => error.code === -32602 && error.message.includes('amenities'),
      `Expected InvalidParams for amenities=${JSON.stringify(value)}`,
    );
  }
});

const expectedAmenities = {
  pool: { id: '7', label: /\bpool\b/i },
  wifi: { id: '4', label: /\bwi-?fi\b/i },
  kitchen: { id: '8', label: /\bkitchen\b/i },
  washer: { id: '33', label: /\bwasher\b/i },
};

test('propertyType rejects unsupported room types through MCP', async () => {
  for (const value of ['', 'house', 'Entire home/apt', 'unknown', 1, null, true, [], ['entire_home'], {}, 'toString', '__proto__']) {
    await assert.rejects(
      client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', propertyType: value } }),
      error => error.code === -32602 && error.message.includes('propertyType'),
      `Expected InvalidParams for propertyType=${JSON.stringify(value)}`,
    );
  }
});

test('buildingType is a separate optional enum and validates through MCP', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.deepEqual(schema.properties.buildingType.enum, ['house', 'apartment', 'guesthouse', 'hotel', 'cabin', 'villa']);
  assert.ok(!schema.required.includes('buildingType'));
  assert.deepEqual(schema.properties.propertyType.enum, ['entire_home', 'private_room', 'shared_room', 'hotel_room']);
  for (const value of ['entire_home', 'castle', 'House', 1, null, true, [], ['house'], {}, '__proto__']) {
    await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', buildingType: value } }),
      error => error.code === -32602 && error.message.includes('buildingType'));
  }
});

test('minimum rating and review count validate through MCP before searching', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.minRating.minimum, 0);
  assert.equal(schema.properties.minRating.maximum, 5);
  assert.equal(schema.properties.minReviewCount.type, 'integer');
  for (const [key, values] of Object.entries({ minRating: [-1, 5.1, '4.5', null, true, []], minReviewCount: [-1, 1.5, '10', null, true, [], Number.MAX_SAFE_INTEGER + 1] })) {
    for (const value of values) await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', [key]: value } }),
      error => error.code === -32602 && error.message.includes(key));
  }
});

test('automatic pagination validates options through MCP before searching', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.targetResults.maximum, 100);
  assert.equal(schema.properties.maxPages.maximum, 5);
  for (const args of [{ targetResults: 0 }, { targetResults: 101 }, { targetResults: '10' }, { targetResults: null }, { maxPages: 2 }, { targetResults: 10, maxPages: 6 }, { cursor: '' }]) {
    await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', ...args } }), error => error.code === -32602);
  }
});

test('sorting schema and validation are exposed through MCP before searching', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.deepEqual(schema.properties.sortBy.enum, ['recommended', 'nightly_price', 'total_price', 'rating', 'review_count', 'nights_covered']);
  assert.deepEqual(schema.properties.sortOrder.enum, ['asc', 'desc']);
  for (const args of [{ sortBy: 'price' }, { sortBy: null }, { sortOrder: 'asc' }, { sortBy: 'rating', sortOrder: 'up' }, { sortBy: 'nights_covered' }]) {
    await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', ...args } }), error => error.code === -32602);
  }
});

test('total budget validates its cap and required currency through MCP', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.maxTotalPrice.type, 'number');
  assert.equal(schema.properties.maxTotalPrice.minimum, 0);
  for (const args of [{ maxTotalPrice: 1500 }, { maxTotalPrice: -1, currency: 'USD' }, { maxTotalPrice: '1500', currency: 'USD' }, { maxTotalPrice: null, currency: 'USD' }, { maxTotalPrice: 0, currency: 'usd' }]) {
    await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', ...args } }), error => error.code === -32602);
  }
});

test('currency validates its input through MCP', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.currency.type, 'string');
  assert.ok(!schema.required.includes('currency'));
  for (const currency of ['$', 'usd', 'EURO', '', null, 1, ['USD']]) {
    await assert.rejects(
      client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', currency } }),
      error => error.code === -32602 && error.message.includes('currency'),
    );
  }
});

test('search rejects incomplete, invalid, or reversed pricing dates', async () => {
  for (const dates of [
    { checkin: '2026-12-01' }, { checkout: '2026-12-04' },
    { checkin: '2026-02-29', checkout: '2026-03-03' },
    { checkin: '2026-12-04', checkout: '2026-12-01' },
    { checkin: '2026-12-01', checkout: '2026-12-01' },
    { checkin: null, checkout: null },
  ]) {
    await assert.rejects(
      client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', ...dates } }),
      error => error.code === -32602 && error.message.includes('checkin'),
    );
  }
});

test('date flexibility rejects unsupported values and requires a date range', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'airbnb_search').inputSchema;
  assert.deepEqual(schema.properties.dateFlexibilityDays.enum, [0, 1, 2, 3, 7, 14]);
  for (const value of [-1, 4, 5, 30, 1.5, '3', null, true, [], {}]) {
    await assert.rejects(
      client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', checkin: '2026-12-15', checkout: '2026-12-18', dateFlexibilityDays: value } }),
      error => error.code === -32602 && error.message.includes('dateFlexibilityDays'),
    );
  }
  await assert.rejects(
    client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', dateFlexibilityDays: 3 } }),
    error => error.code === -32602 && error.message.includes('checkin'),
  );
});

test('partial-stay discovery advertises an off-by-default toggle and validates before searching', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(t => t.name === 'airbnb_search').inputSchema;
  assert.equal(schema.properties.discoverPartialStays.type, 'boolean');
  assert.equal(schema.properties.discoverPartialStays.default, false);
  assert.equal(schema.properties.maxPartialSearches.maximum, 8);
  for (const args of [
    { discoverPartialStays: true }, { discoverPartialStays: 'yes' },
    { discoverPartialStays: true, checkin: '2027-01-01', checkout: '2027-01-05', cursor: 'next' },
    { discoverPartialStays: true, checkin: '2027-01-01', checkout: '2027-01-05', maxPartialSearches: 9 },
    { discoverPartialStays: true, checkin: '2027-01-01', checkout: '2027-01-05', minPartialNights: 0 },
    { minPartialNights: 2 },
  ]) {
    await assert.rejects(client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', ...args } }), e => e.code === -32602);
  }
});

for (const [days, airbnbCode] of [[0, null], [1, '0'], [2, '3'], [3, '1'], [7, '2'], [14, '6']]) {
  test(`live availability flexibility ${days} days`, { skip: process.env.AIRBNB_LIVE_TESTS !== 'true' }, async () => {
    const checkin = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 63 * 86400000).toISOString().slice(0, 10);
    const result = await client.callTool({ name: 'airbnb_search', arguments: {
      location: 'Boston, MA', checkin, checkout, dateFlexibilityDays: days, adults: 2, currency: 'USD',
    } });
    assert.ok(!result.isError, JSON.stringify(result) + '\n' + serverLog);
    const data = JSON.parse(result.content[0].text);
    const searchUrl = new URL(data.searchUrl);
    assert.equal(data.availabilityFilter.applied, true);
    assert.equal(searchUrl.searchParams.get('flexible_date_search_filter_type'), airbnbCode);
    assert.ok(data.searchResults.length > 0);
    for (const row of data.searchResults) {
      assert.equal(row.availability.requestedCheckin, checkin);
      assert.equal(row.availability.requestedCheckout, checkout);
      assert.equal(row.availability.dateFlexibilityDays, days);
      assert.ok(row.availability.withinRequestedWindow === true || row.availability.matchType === 'partial_stay');
      assert.ok(row.availability.label.length > 0);
      assert.notEqual(row.pricing.datesMatchPrice, false);
      if (row.availability.matchType === 'partial_stay') {
        assert.match(row.availability.label, /Partial stay:/);
        assert.ok(row.availability.coveredRequestedNights > 0);
        assert.ok(row.availability.coveredRequestedNights < row.availability.requestedNights);
      } else if (days === 0) {
        assert.equal(row.availability.matchesRequestedDates, true);
        assert.equal(row.pricing.checkin, checkin);
        assert.equal(row.pricing.checkout, checkout);
      }
      assert.equal(row.availability.matchedCheckin, row.pricing.checkin);
      assert.equal(row.availability.matchedCheckout, row.pricing.checkout);
      const link = new URL(row.url);
      assert.equal(link.searchParams.get('check_in'), row.pricing.checkin);
      assert.equal(link.searchParams.get('check_out'), row.pricing.checkout);
      assert.equal(link.searchParams.get('adults'), '2');
      assert.equal(link.searchParams.get('currency'), row.pricing.currency);
    }
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok);
    const $ = cheerio.load(await response.text());
    const page = JSON.parse($('#data-deferred-state-0').text());
    const key = page.niobeClientData.find(entry => entry[0].startsWith('StaysSearch:'))[0];
    const request = JSON.parse(key.slice('StaysSearch:'.length)).staysSearchRequest;
    const filter = request.rawParams.find(param => param.filterName === 'flexibleDateSearchFilterType');
    assert.deepEqual(filter?.filterValues ?? null, airbnbCode === null ? null : [airbnbCode]);
    console.log(`Airbnb accepted ${days === 0 ? 'exact dates' : `±${days} days`}; ${data.searchResults.length} listings with matching pricing and date links`);
  });
}

for (const currency of ['USD', 'EUR', undefined]) {
  test(`live pricing ${currency ?? 'default with suggested dates'}`, { skip: process.env.AIRBNB_LIVE_TESTS !== 'true' }, async () => {
    const checkin = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 33 * 86400000).toISOString().slice(0, 10);
    const args = currency ? { currency, checkin, checkout, minPrice: 50, maxPrice: 500 } : {};
    const result = await client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', adults: 2, ...args } });
    assert.ok(!result.isError, JSON.stringify(result) + '\n' + serverLog);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.searchResults.length > 0);
    assert.ok(Number.isFinite(Date.parse(data.retrievedAt)));
    assert.equal(data.availabilityFilter.applied, Boolean(currency));
    const url = new URL(data.searchUrl);
    assert.equal(url.searchParams.get('currency'), currency ?? null);
    assert.equal(url.searchParams.has('flexible_date_search_filter_type'), false);
    assert.equal(url.searchParams.get('price_filter_input_type'), currency ? '0' : null);
    for (const listing of data.searchResults) {
      const p = listing.pricing;
      assert.match(p.currency, /^[A-Z]{3}$/);
      assert.ok(p.stayTotal > 0);
      assert.ok(p.nights > 0);
      assert.ok(p.averageNightlyTotal > 0);
      assert.equal(typeof p.stayTotalIsApproximate, 'boolean');
      assert.ok(Array.isArray(p.breakdown));
      assert.equal(p.display.primary, listing.structuredDisplayPrice.primaryLine.accessibilityLabel);
      if (currency) {
        assert.equal(p.currency, currency);
        assert.equal(p.currencyMatchesRequest, true);
        assert.equal(p.checkin, checkin);
        assert.equal(p.checkout, checkout);
        assert.equal(p.nights, 3);
        assert.equal(p.datesSource, 'requested');
      } else {
        assert.equal(p.requestedCurrency, null);
        assert.equal(p.datesSource, 'airbnb_suggested');
      }
    }
    console.log(`Verified structured pricing for ${data.searchResults.length} listings: ${currency ?? 'default currency / suggested dates'}`);
    console.log(JSON.stringify(data.searchResults[0].pricing));
  });
}

for (const [propertyType, roomType] of Object.entries({
  entire_home: 'Entire home/apt',
  private_room: 'Private room',
  shared_room: 'Shared room',
  hotel_room: 'Hotel room',
})) {
  test(`live room type ${propertyType} is applied by Airbnb`, { skip: process.env.AIRBNB_LIVE_TESTS !== 'true' }, async () => {
    const result = await client.callTool({ name: 'airbnb_search', arguments: { location: 'Boston, MA', propertyType } });
    assert.ok(!result.isError, JSON.stringify(result) + '\n' + serverLog);
    const data = JSON.parse(result.content[0].text);
    const url = new URL(data.searchUrl);
    assert.deepEqual(url.searchParams.getAll('room_types[]'), [roomType]);
    assert.equal(url.searchParams.has('l2_property_type_ids[]'), false);
    assert.ok(Array.isArray(data.searchResults));

    // Verify Airbnb actually interprets the filter, including when inventory is
    // empty. A URL-only assertion could pass even if Airbnb ignored the parameter.
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `HTTP ${response.status}`);
    const $ = cheerio.load(await response.text());
    const page = JSON.parse($('#data-deferred-state-0').text());
    const cacheKey = page.niobeClientData.find(entry => entry[0].startsWith('StaysSearch:'))[0];
    const request = JSON.parse(cacheKey.slice('StaysSearch:'.length)).staysSearchRequest;
    assert.deepEqual(request.rawParams.find(param => param.filterName === 'roomTypes')?.filterValues, [roomType]);
    assert.ok(!request.rawParams.some(param => param.filterName === 'l2PropertyTypeIds'));
    console.log(`Airbnb accepted ${roomType}; MCP returned ${data.searchResults.length} listings`);
  });
}

// Opt in: live results depend on Airbnb's page format and network availability.
for (const filters of [
  { minBedrooms: 3 },
  { minBeds: 3 },
  { minBathrooms: 2 },
  { minBedrooms: 2, minBathrooms: 2 },
  { minBedrooms: 0, minBeds: 0, minBathrooms: 0, amenities: [] },
  { amenities: ['pool'] },
  { minBedrooms: 2, minBeds: 3, minBathrooms: 2, amenities: ['wifi', 'kitchen', 'washer', 'wifi'] },
]) {
  test(`live search honors ${JSON.stringify(filters)}`, { skip: process.env.AIRBNB_LIVE_TESTS !== 'true' }, async () => {
    const result = await client.callTool({
      name: 'airbnb_search',
      arguments: { location: 'Boston, MA', adults: 2, ...filters },
    });
    assert.ok(!result.isError, JSON.stringify(result) + '\n' + serverLog);
    const data = JSON.parse(result.content[0].text);
    const url = new URL(data.searchUrl);
    assert.equal(url.searchParams.has('room_types[]'), false, 'Omitted room type must not constrain the search');
    assert.equal(url.searchParams.has('l2_property_type_ids[]'), false);
    for (const [name, queryName] of [['minBedrooms', 'min_bedrooms'], ['minBeds', 'min_beds'], ['minBathrooms', 'min_bathrooms']]) {
      assert.equal(url.searchParams.get(queryName), filters[name] === undefined ? null : String(filters[name]));
    }
    const requestedAmenities = [...new Set(filters.amenities || [])];
    assert.deepEqual(url.searchParams.getAll('amenities[]'), requestedAmenities.map(name => expectedAmenities[name].id));
    assert.ok(data.searchResults.length > 0, 'Expected live listings');
    for (const listing of data.searchResults) {
      const summary = listing.structuredContent?.primaryLine || '';
      if (filters.minBedrooms > 0) {
        const bedrooms = summary.match(/(\d+) bedrooms?\b/i);
        assert.ok(bedrooms, `Missing bedroom count: ${listing.id}: ${summary}`);
        assert.ok(Number(bedrooms[1]) >= filters.minBedrooms, `Bedroom minimum not met: ${listing.id}: ${summary}`);
      }
      if (filters.minBeds > 0) {
        // Cards can show either a total ("3 beds") or bed types ("2 queen beds").
        const beds = [...summary.matchAll(/(\d+) (?:[a-z-]+ )*beds?\b/gi)];
        assert.ok(beds.length > 0, `Missing bed count: ${listing.id}: ${summary}`);
        const bedCount = beds.reduce((total, match) => total + Number(match[1]), 0);
        assert.ok(bedCount >= filters.minBeds, `Bed minimum not met: ${listing.id}: ${summary}`);
      }
      if (filters.minBathrooms > 0) {
        const bathrooms = summary.match(/(\d+(?:\.\d+)?) (?:shared |private )?baths?\b/i);
        assert.ok(bathrooms, `Missing bathroom count: ${listing.id}: ${summary}`);
        assert.ok(Number(bathrooms[1]) >= filters.minBathrooms, `Bathroom minimum not met: ${listing.id}: ${summary}`);
      }
    }
    if (requestedAmenities.length) {
      // Search cards omit most amenities. Check actual details for a sample of
      // returned listings, excluding Airbnb's unavailable/"Not included" entries.
      for (const listing of data.searchResults.slice(0, 3)) {
        const detailsResult = await client.callTool({ name: 'airbnb_listing_details', arguments: { id: listing.id } });
        assert.ok(!detailsResult.isError, JSON.stringify(detailsResult));
        const details = JSON.parse(detailsResult.content[0].text);
        const groups = details.details.find(section => section.id === 'AMENITIES_DEFAULT')?.seeAllAmenitiesGroups;
        assert.ok(groups, `Missing amenities for ${listing.id}`);
        const offered = Object.entries(groups)
          .filter(([category]) => !/not included/i.test(category))
          .flatMap(([, labels]) => labels.split(', '))
          .filter(label => !/— unavailable/.test(label))
          .join(' | ');
        for (const name of requestedAmenities) {
          assert.match(offered, expectedAmenities[name].label, `${listing.id} does not list ${name} as available`);
        }
      }
      console.log(`Verified requested amenities in details for ${Math.min(3, data.searchResults.length)} listings`);
    }
    console.log(`Verified ${data.searchResults.length} listings for ${JSON.stringify(filters)}`);
  });
}
