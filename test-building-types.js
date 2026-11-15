import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BUILDING_TYPES, applyBuildingType, validateBuildingType } from './dist/building-types.js';
import { partialSearchUrl } from './dist/partial-stays.js';
import { extractListing, normalizeListingInput } from './dist/listing.js';

const fixture = JSON.parse(readFileSync(new URL('./test/fixtures/building-types.json', import.meta.url)));
const queryToRequest = { 'l2_property_type_ids[]': 'l2PropertyTypeIds', 'property_type_id[]': 'propertyTypeId', 'kg_and_tags[]': 'kgAndTags' };

test('broad building groups match the current Airbnb controls, including hotel tags', () => {
  for (const name of ['house', 'apartment', 'guesthouse', 'hotel']) {
    const filter = BUILDING_TYPES[name];
    const control = fixture.controls.find(c => c.label === filter.label);
    assert.ok(control, name);
    const param = control.searchParams.find(p => `${p.key}[]` === filter.parameter);
    assert.equal(param.value.longValue ?? param.value.stringValue, filter.value, name);
  }
  // These groups are intentionally not the older, widely copied 2/8 mapping.
  assert.equal(BUILDING_TYPES.apartment.value, '3');
  assert.equal(BUILDING_TYPES.guesthouse.value, '2');
});

test('specific types match applied Airbnb filters and actual result labels', () => {
  for (const name of ['cabin', 'villa']) {
    const filter = BUILDING_TYPES[name];
    const observed = fixture.searches.find(s => s.buildingType === name);
    assert.deepEqual(observed.appliedFilters.find(p => p.filterName === queryToRequest[filter.parameter]).filterValues, [filter.value]);
    assert.ok(observed.sampleTitles.every(title => title.startsWith(`${filter.label} in `)));
  }
});

test('building types preserve room types and other filters, including during partial discovery', () => {
  for (const [name, filter] of Object.entries(BUILDING_TYPES)) {
    const url = new URL('https://www.airbnb.com/s/Boston/homes?room_types[]=Private+room&amenities[]=4&min_beds=2&adults=2&currency=EUR&checkin=2027-01-01&checkout=2027-01-05');
    applyBuildingType(url, name);
    assert.deepEqual(url.searchParams.getAll(filter.parameter), [filter.value]);
    assert.deepEqual(url.searchParams.getAll('room_types[]'), ['Private room']);
    assert.equal(url.searchParams.get('amenities[]'), '4');
    const shorter = partialSearchUrl(url, { checkin: '2027-01-02', checkout: '2027-01-05' });
    assert.deepEqual(shorter.searchParams.getAll(filter.parameter), [filter.value]);
    assert.equal(shorter.searchParams.get('room_types[]'), 'Private room');
    assert.equal(shorter.searchParams.get('min_beds'), '2');
  }
  const unrestricted = new URL('https://www.airbnb.com/s/Boston/homes');
  applyBuildingType(unrestricted, undefined);
  assert.equal(unrestricted.search, '');
});

test('unsupported building types never silently become an unrestricted search', () => {
  for (const value of ['', 'entire_home', 'House', 'castle', 1, true, null, [], ['house'], {}, '__proto__']) {
    assert.throws(() => validateBuildingType(value), /buildingType/);
  }
});

test('listing building type comes from Airbnb taxonomy rather than its room-type label', () => {
  const data = JSON.parse(readFileSync(new URL('./test/fixtures/listing.json', import.meta.url)));
  const node = data.niobeClientData[1][1].data.node;
  node.propertyType = 'CABIN';
  node.pdpPresentation.sharingConfig.propertyType = 'Entire home';
  const input = normalizeListingInput({ id: '123' });
  const listing = extractListing(data, '', input);
  assert.equal(listing.buildingType, 'cabin');
  assert.equal(listing.propertyType, 'Entire home');
  delete node.propertyType;
  assert.equal(extractListing(data, '', input).buildingType, null);
});

test('live building filters are accepted independently of room filters', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 180000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const cheerio = await import('cheerio');
  const client = new Client({ name: 'building-type-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    transport.stderr.on('data', () => {});
    for (const [name, filter] of Object.entries(BUILDING_TYPES)) {
      const location = name === 'cabin' ? 'Rhododendron, OR' : name === 'villa' ? 'Bali, Indonesia' : 'Boston, MA';
      const propertyType = name === 'hotel' ? 'hotel_room' : 'entire_home';
      const expectedRoom = propertyType === 'hotel_room' ? 'Hotel room' : 'Entire home/apt';
      const result = await client.callTool({ name: 'airbnb_search', arguments: { location, propertyType, buildingType: name, adults: 2 } });
      assert.equal(result.isError, false, JSON.stringify(result));
      const data = JSON.parse(result.content[0].text);
      const url = new URL(data.searchUrl);
      assert.deepEqual(url.searchParams.getAll(filter.parameter), [filter.value]);
      assert.equal(url.searchParams.get('room_types[]'), expectedRoom);
      assert.ok(data.searchResults.length > 0, `No live ${name} results`);
      assert.ok(data.searchResults.every(r => typeof r.title === 'string' && r.title.length > 0));
      if (name === 'cabin' || name === 'villa') {
        assert.ok(data.searchResults.every(r => r.title.startsWith(`${filter.label} in `)), JSON.stringify(data.searchResults.map(r => r.title)));
      }
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30000) });
      assert.equal(response.ok, true);
      const $ = cheerio.load(await response.text());
      const payload = JSON.parse($('#data-deferred-state-0').text());
      const entry = payload.niobeClientData.find(e => e[0].startsWith('StaysSearch:'));
      const applied = JSON.parse(entry[0].slice('StaysSearch:'.length)).staysSearchRequest.rawParams;
      assert.deepEqual(applied.find(p => p.filterName === queryToRequest[filter.parameter])?.filterValues, [filter.value]);
      assert.deepEqual(applied.find(p => p.filterName === 'roomTypes')?.filterValues, [expectedRoom]);
      console.log(`Airbnb applied ${name} + ${propertyType}; returned ${data.searchResults.length} listings.`);
    }
  } finally { await client.close(); }
});
