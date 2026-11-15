import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeListingInput } from './dist/listing.js';
import { quotePageMetadata, quoteOperationHash, quoteRequest, parseDatedQuote, fetchDatedBooking } from './dist/booking.js';

const { cases } = JSON.parse(readFileSync(new URL('./test/fixtures/booking.json', import.meta.url)));
const context = normalizeListingInput({ id: '53610715', checkin: '2027-02-08', checkout: '2027-02-11', adults: 2, currency: 'USD' });
const hash = 'a'.repeat(64);
const script = `name:'StaysPdpBookItQuery',type:'query',operationId:'${hash}'`;
const page = version => `<script id="data-injector-instances">${JSON.stringify({
  root: [['BootstrapDataToken', { 'layout-init': { api_config: { key: 'public-test-key' } }, serverDeterminedCurrency: 'USD' }]]
})}</script><script src="https://a0.muscache.com/airbnb/static/packages/web/en/frontend/gp-stays-pdp-route/routes/PdpPlatformRoute.${version}.js"></script>`;

test('quote metadata uses only the observed Airbnb asset host and operation', () => {
  const result = quotePageMetadata(page('metadata'));
  assert.equal(result.apiKey, 'public-test-key');
  assert.equal(result.currency, 'USD');
  assert.match(result.assetUrl, /PdpPlatformRoute\.metadata\.js$/);
  assert.equal(quoteOperationHash(script), hash);
  assert.throws(() => quoteOperationHash(script.replace('StaysPdpBookItQuery', 'UnrelatedQuery')));
  assert.equal(quotePageMetadata(page('metadata').replace('a0.muscache.com', 'a0.muscache.com.evil.test')).assetUrl, null);
  assert.equal(quotePageMetadata('<html></html>').apiKey, null);
});

test('quote request binds the exact listing, dates, all guests and currency', () => {
  const input = normalizeListingInput({ url: 'https://www.airbnb.com/rooms/1765966961853129231?check_in=2027-01-01&check_out=2027-01-11&adults=2&children=1&infants=1&pets=1', currency: 'EUR' });
  const url = quoteRequest(input, 'EUR', hash);
  const vars = JSON.parse(url.searchParams.get('variables'));
  assert.equal(url.origin, 'https://www.airbnb.com');
  assert.equal(url.searchParams.get('currency'), 'EUR');
  assert.equal(Buffer.from(vars.id, 'base64').toString(), 'DemandStayListing:1765966961853129231');
  assert.deepEqual(vars.dateRange, { startDate: '2027-01-01', endDate: '2027-01-11' });
  assert.deepEqual(vars.guestCounts, { numberOfAdults: 2, numberOfChildren: 1, numberOfInfants: 1, numberOfPets: 1 });
  assert.throws(() => quoteRequest(normalizeListingInput({ id: '123' }), 'USD', hash));
});

test('available quote uses the exact total, fee-inclusive rate and cancellation summary', () => {
  const quote = parseDatedQuote(cases.available, context, 'USD');
  assert.equal(quote.quoteStatus, 'checked');
  assert.equal(quote.available, true);
  assert.equal(quote.datesVerified, true);
  assert.equal(quote.pricing.checkin, context.checkin);
  assert.equal(quote.pricing.checkout, context.checkout);
  assert.equal(quote.pricing.stayTotal, 907.93);
  assert.equal(quote.pricing.stayTotalSource, 'breakdown');
  assert.equal(quote.pricing.stayTotalIsApproximate, false);
  assert.equal(quote.pricing.averageNightlyTotal, 302.64);
  assert.equal(quote.pricing.quotedNightlyRate, 302.64);
  assert.equal(quote.pricing.baseNightlyRate, null);
  assert.equal(quote.pricing.feesIncluded, true);
  assert.equal(quote.pricing.feesItemized, false);
  assert.equal(quote.pricing.taxesIncluded, null);
  assert.equal(quote.pricing.currencySource, 'quote_request');
  assert.equal(quote.pricing.breakdown.filter(item => item.kind === 'nightly_subtotal').length, 1);
  assert.equal(quote.pricing.priceReductions.length, 1);
  assert.equal(quote.cancellationPolicy.summary, 'Free cancellation before January 9');
  assert.equal(quote.cancellationPolicy.fullTermsAvailable, false);
  assert.equal(quote.canInstantBook, true);
  assert.ok(!JSON.stringify(quote).includes('traceId'));
});

test('unavailable dates and minimum stays remain explicit without inventing prices', () => {
  for (const [name, message] of [['unavailable', 'Those dates are not available'], ['minimumStay', 'Minimum stay is 10 nights']]) {
    const input = normalizeListingInput({ id: name === 'minimumStay' ? '1765966961853129231' : '53610715', checkin: '2027-01-15', checkout: '2027-01-18', adults: 2 });
    const quote = parseDatedQuote(cases[name], input, 'USD');
    assert.equal(quote.quoteStatus, 'checked');
    assert.equal(quote.available, false);
    assert.equal(quote.availabilityStatus, 'unavailable');
    assert.equal(quote.datesVerified, true);
    assert.equal(quote.pricing, null);
    assert.equal(quote.message, message);
  }
});

test('errors, missing availability, unsupported responses and mismatched quotes are rejected', () => {
  assert.throws(() => parseDatedQuote({ errors: [{ message: 'Provider error' }] }, context, 'USD'));
  assert.throws(() => parseDatedQuote({ data: {} }, context, 'USD'));
  const mismatch = structuredClone(cases.available);
  mismatch.data.node.id = Buffer.from('DemandStayListing:999').toString('base64');
  assert.throws(() => parseDatedQuote(mismatch, context, 'USD'), /different listing/);
  const otherDates = normalizeListingInput({ id: context.id, checkin: '2027-02-15', checkout: '2027-02-18' });
  assert.throws(() => parseDatedQuote(cases.available, otherDates, 'USD'), /date label/);
  const wrongNights = structuredClone(cases.available);
  wrongNights.data.node.pdpPresentation.bookIt.structuredDisplayPrice.primaryLine.qualifier = 'for 4 nights';
  assert.throws(() => parseDatedQuote(wrongNights, context, 'USD'), /night count/);
  const missing = structuredClone(cases.available);
  delete missing.data.node.pdpPresentation.bookIt.availability.isAvailable;
  assert.throws(() => parseDatedQuote(missing, context, 'USD'));
});

test('English date labels support month and year boundaries without accepting different dates', () => {
  for (const [checkin, checkout, label] of [
    ['2027-02-28', '2027-03-03', 'Feb 28 – Mar 3'],
    ['2026-12-30', '2027-01-02', 'Dec 30, 2026 – Jan 2, 2027'],
    ['2027-02-08', '2027-02-11', 'Feb 8 – 11, 2027'],
  ]) {
    const response = structuredClone(cases.available);
    response.data.node.pdpPresentation.bookIt.selectedDates = label;
    const input = normalizeListingInput({ id: context.id, checkin, checkout });
    assert.equal(parseDatedQuote(response, input, 'USD').datesVerified, true);
    response.data.node.pdpPresentation.bookIt.selectedDates = 'Choose dates';
    assert.throws(() => parseDatedQuote(response, input, 'USD'), /date label/);
  }
});

test('missing price stays unknown and a price on an unavailable stay is not quoted', () => {
  const response = structuredClone(cases.available);
  response.data.node.pdpPresentation.bookIt.structuredDisplayPrice = null;
  const noPrice = parseDatedQuote(response, context, 'USD');
  assert.equal(noPrice.available, true);
  assert.equal(noPrice.pricing, null);
  assert.equal(noPrice.pricingStatus, 'not_provided');
  const unavailable = structuredClone(cases.available);
  unavailable.data.node.pdpPresentation.bookIt.availability.isAvailable = false;
  assert.equal(parseDatedQuote(unavailable, context, 'USD').pricing, null);
});

test('fetcher discovers the current operation and never caches a quote', async () => {
  const calls = [];
  const fetchText = async (url, headers) => {
    calls.push({ url, headers });
    return url.endsWith('.js') ? script : JSON.stringify(cases.available);
  };
  const first = await fetchDatedBooking(page('cache'), context, () => true, fetchText);
  const second = await fetchDatedBooking(page('cache'), context, () => true, fetchText);
  assert.equal(first.quoteStatus, 'checked');
  assert.equal(second.quoteStatus, 'checked');
  assert.equal(calls.filter(c => c.url.endsWith('.js')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('/api/v3/')).length, 2);
  assert.equal(calls[1].headers['X-Airbnb-API-Key'], 'public-test-key');
});

test('network and metadata failures report unknown rather than unavailable', async () => {
  for (const fetchText of [
    async () => { throw new Error('request failed with a sensitive URL'); },
    async url => url.endsWith('.js') ? script : 'not JSON',
    async url => url.endsWith('.js') ? script : JSON.stringify({ errors: [{ message: 'Provider details' }] }),
  ]) {
    const result = await fetchDatedBooking(page('failure'), context, () => true, fetchText);
    assert.equal(result.quoteStatus, 'error');
    assert.equal(result.available, null);
    assert.equal(result.availabilityStatus, 'unknown');
    assert.equal(result.datesVerified, false);
    assert.equal(result.pricing, null);
    assert.ok(!result.message.includes('sensitive'));
    assert.ok(!result.message.includes('Provider details'));
  }
  const result = await fetchDatedBooking('', context, () => true, async () => assert.fail('Should not fetch without metadata'));
  assert.equal(result.quoteStatus, 'error');
});

test('robots checks prevent the dated lookup, including path-specific rules', async () => {
  const blocked = await fetchDatedBooking(page('robots'), context, () => false, async () => assert.fail('Should not fetch'));
  assert.equal(blocked.quoteStatus, 'blocked');
  assert.equal(blocked.available, null);
  const paths = [];
  const specific = await fetchDatedBooking(page('robots'), context, path => { paths.push(path); return paths.length === 1; }, async url => {
    assert.ok(url.endsWith('.js'), 'Must not fetch the blocked API URL');
    return script;
  });
  assert.equal(specific.quoteStatus, 'blocked');
  assert.match(paths[1], /variables=/);
});
