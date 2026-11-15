import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeListingInput, extractListing, listingSections } from './dist/listing.js';

const fixture = JSON.parse(readFileSync(new URL('./test/fixtures/listing.json', import.meta.url)));
const id = '1765966961853129231';

test('URL imports stay context and preserves large listing IDs without tracking', () => {
  const result = normalizeListingInput({ url: `https://www.airbnb.co.uk/rooms/${id}?check_in=2027-01-10&check_out=2027-01-13&adults=2&children=1&currency=GBP&source_impression_id=tracking` });
  assert.equal(result.id, id);
  assert.equal(result.checkin, '2027-01-10');
  assert.equal(result.checkout, '2027-01-13');
  assert.equal(result.adults, 2);
  assert.equal(result.children, 1);
  assert.equal(result.currency, 'GBP');
  assert.equal(result.listingUrl.hostname, 'www.airbnb.com');
  assert.equal(result.listingUrl.searchParams.has('source_impression_id'), false);
});

test('explicit arguments override URL context, and ID-only calls still work', () => {
  const result = normalizeListingInput({ id, url: `https://airbnb.com/rooms/${id}/?adults=3&currency=USD&check_in=2027-01-10&check_out=2027-01-13`, adults: 2, currency: 'EUR', checkin: '2027-02-01', checkout: '2027-02-05' });
  assert.equal(result.adults, 2);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.checkin, '2027-02-01');
  assert.equal(result.checkout, '2027-02-05');
  assert.equal(normalizeListingInput({ id }).id, id);
  assert.equal(normalizeListingInput({ id }).adults, 1);
});

test('invalid URLs, conflicting IDs and invalid stay context are rejected', () => {
  for (const input of [
    {}, { id: 53610715 }, { id: '../x' }, { id: '0' }, { id, url: 'https://airbnb.com/rooms/123' },
    ...['https://example.com/rooms/123', 'https://airbnb.com.evil.test/rooms/123', 'https://airbnb.com@evil.test/rooms/123', 'file:///rooms/123', 'https://airbnb.com/l/short', 'https://abnb.me/short', 'https://airbnb.com/rooms/123/extra', 'https://airbnb.com:444/rooms/123'].map(url => ({ url })),
    { id, checkin: '2027-02-30', checkout: '2027-03-02' }, { id, checkin: '2027-01-01' },
    { id, checkin: '2027-01-02', checkout: '2027-01-01' }, { id, currency: 'usd' },
    { id, adults: 0 }, { id, adults: '2' }, { id, children: 1.5 }, { id, pets: -1 },
    { url: `https://airbnb.com/rooms/${id}?adults=2abc` }
  ]) assert.throws(() => normalizeListingInput(input), undefined, JSON.stringify(input));
});

test('modern page details are recovered from stubs and a non-first data entry', () => {
  const data = extractListing(fixture, '', normalizeListingInput({ id, checkin: '2027-01-01', checkout: '2027-01-04' }));
  assert.equal(listingSections(fixture).length, 2);
  assert.equal(data.title, 'Example apartment');
  assert.equal(data.description, 'A sunny apartment.\nThe space\nTwo bedrooms & a kitchen.');
  assert.deepEqual(data.overview.items, ['4 guests', '2 bedrooms', '3 beds', '1 bath']);
  assert.equal(data.personCapacity, 4);
  assert.equal(data.host.passportData.name, 'Example host');
  assert.equal(data.ratings.listingRatingStats.overallRatingStats.ratingAverage, 4.93);
  assert.equal(data.location.isExactLocation, false);
  assert.ok(data.houseRules.groupItems.length);
  assert.ok(data.safetyAndProperty.groupItems.length);
  assert.ok(data.amenities.flatMap(g => g.amenities).some(a => a.available === false));
  assert.ok(data.photos[0].url.startsWith('https://'));
  assert.equal(data.booking.available, null);
  assert.equal(data.booking.availabilityStatus, 'unknown');
  assert.equal(data.booking.pricingStatus, 'not_provided');
  assert.equal(data.booking.datesVerified, false);
  assert.equal(data.booking.requestedCheckin, '2027-01-01');
  assert.equal(data.booking.pricing, null);
  assert.equal(data.coverage.fullReviewHistoryIncluded, false);
  assert.ok(!JSON.stringify(data).includes('__typename'));
});

test('legacy section pages retain description, amenities and location', () => {
  const data = { niobeClientData: [['legacy', { data: { presentation: { stayProductDetailPage: { sections: { sections: [
    { sectionId: 'DESCRIPTION_DEFAULT', section: { htmlDescription: { htmlText: 'Legacy<br />description' } } },
    { sectionId: 'LOCATION_DEFAULT', section: { lat: 10, lng: 20 } },
    { sectionId: 'AMENITIES_DEFAULT', section: { seeAllAmenitiesGroups: [{ title: 'Amenities', amenities: [{ title: 'Wifi', available: false }] }] } }
  ] } } } } }]] };
  const listing = extractListing(data, '<meta property="og:title" content="Legacy stay">', normalizeListingInput({ id }));
  assert.equal(listing.title, 'Legacy stay');
  assert.equal(listing.description, 'Legacy\ndescription');
  assert.equal(listing.location.lat, 10);
  assert.equal(listing.amenities[0].amenities[0].available, false);
  assert.ok(listing.coverage.missingFields.includes('host'));
});

test('embedded price keeps nightly/total units without assuming URL dates were priced', () => {
  const data = structuredClone(fixture);
  const book = listingSections(data).find(s => s.sectionId === 'BOOK_IT_SIDEBAR').section;
  book.structuredDisplayPrice = {
    primaryLine: { price: '$450', qualifier: 'for 3 nights', accessibilityLabel: '$450 for 3 nights' }
  };
  book.available = false;
  const html = '<script id="data-injector-instances">{"BootstrapDataToken":[["token",{"serverDeterminedCurrency":"USD"}]]}</script>';
  const { booking } = extractListing(data, html, normalizeListingInput({ id, checkin: '2027-01-01', checkout: '2027-01-04', currency: 'EUR' }));
  assert.equal(booking.availabilityStatus, 'unavailable');
  assert.equal(booking.pricingStatus, 'present_on_page');
  assert.equal(booking.pricing.stayTotal, 450);
  assert.equal(booking.pricing.averageNightlyTotal, 150);
  assert.equal(booking.pricing.baseNightlyRate, null);
  assert.equal(booking.pricing.currencyMatchesRequest, false);
  assert.equal(booking.pricing.datesSource, 'unknown');
  assert.equal(booking.pricing.checkin, null);
  assert.equal(booking.datesVerified, false);
});

const client = new Client({ name: 'listing-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'], stderr: 'pipe' });
before(async () => { transport.stderr?.on('data', () => {}); await client.connect(transport); });
after(async () => { await client.close(); });

test('MCP advertises URL-or-ID input and rejects invalid requests', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(t => t.name === 'airbnb_listing_details').inputSchema;
  assert.equal(schema.properties.url.type, 'string');
  assert.deepEqual(schema.anyOf, [{ required: ['id'] }, { required: ['url'] }]);
  for (const args of [{}, { id: 123 }, { url: 'https://example.com/rooms/123' }, { id, adults: -1 }]) {
    await assert.rejects(client.callTool({ name: 'airbnb_listing_details', arguments: args }), e => e.code === -32602);
  }
});

test('live URL and ID calls expose public listing details', { skip: process.env.AIRBNB_LIVE_TESTS !== 'true', timeout: 90000 }, async () => {
  for (const args of [{ url: `https://www.airbnb.com/rooms/${id}?check_in=2027-01-15&check_out=2027-01-18&adults=2&currency=USD` }, { id: '53610715' }]) {
    const result = await client.callTool({ name: 'airbnb_listing_details', arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.listing.title);
    assert.ok(data.listing.description.length > 100);
    assert.ok(data.listing.amenities.length > 0);
    assert.ok(data.listing.photos.length > 0);
    assert.ok(data.listing.host);
    assert.ok(data.listing.houseRules);
    assert.ok(Array.isArray(data.details));
    if (args.url) {
      assert.equal(data.listing.booking.requestedCheckin, '2027-01-15');
      assert.equal(new URL(data.listingUrl).searchParams.get('adults'), '2');
    }
  }
});
