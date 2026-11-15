import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeAvailability, filterByAvailability } from './dist/availability.js';
import { extractPricing } from './dist/pricing.js';

test('exact dates match only the requested check-in and check-out', () => {
  const requested = { checkin: '2026-12-15', checkout: '2026-12-18' };
  const exact = describeAvailability(requested, requested);
  assert.equal(exact.matchesRequestedDates, true);
  assert.equal(exact.withinRequestedWindow, true);
  assert.equal(exact.matchesRequestedStayLength, true);
  assert.equal(exact.matchType, 'exact_dates');
  assert.match(exact.label, /Full requested stay/);
  const shifted = describeAvailability({ checkin: '2026-12-16', checkout: '2026-12-19' }, requested);
  assert.equal(shifted.matchesRequestedDates, false);
  assert.equal(shifted.withinRequestedWindow, false);
});

test('flexible dates compare both endpoints and retain the actual stay length', () => {
  const requested = { checkin: '2026-12-15', checkout: '2026-12-18', dateFlexibilityDays: 3 };
  const shifted = describeAvailability({ checkin: '2026-12-12', checkout: '2026-12-21' }, requested);
  assert.equal(shifted.withinRequestedWindow, true);
  assert.equal(shifted.matchesRequestedDates, false);
  assert.equal(shifted.checkinOffsetDays, -3);
  assert.equal(shifted.checkoutOffsetDays, 3);
  assert.equal(shifted.matchesRequestedStayLength, false);
  const outside = describeAvailability({ checkin: '2026-12-12', checkout: '2026-12-22' }, requested);
  assert.equal(outside.withinRequestedWindow, false);
});

test('missing or invalid dates do not claim availability', () => {
  const missing = describeAvailability({ checkin: null, checkout: null }, { checkin: '2026-12-15', checkout: '2026-12-18' });
  assert.equal(missing.withinRequestedWindow, null);
  assert.equal(missing.matchesRequestedDates, null);
  const suggested = describeAvailability({ checkin: '2026-12-15', checkout: '2026-12-18' }, {});
  assert.equal(suggested.matchesRequestedDates, null);
  assert.equal(suggested.withinRequestedWindow, null);
  const invalid = describeAvailability({ checkin: '2026-02-30', checkout: '2026-03-04' }, { checkin: '2026-02-27', checkout: '2026-03-03' });
  assert.equal(invalid.withinRequestedWindow, null);
});

test('date offsets cross year and daylight-saving boundaries in calendar days', () => {
  const year = describeAvailability({ checkin: '2027-01-01', checkout: '2027-01-04' }, { checkin: '2026-12-31', checkout: '2027-01-03', dateFlexibilityDays: 1 });
  assert.equal(year.checkinOffsetDays, 1);
  assert.equal(year.checkoutOffsetDays, 1);
  assert.equal(year.withinRequestedWindow, true);
  const dst = describeAvailability({ checkin: '2026-03-09', checkout: '2026-03-12' }, { checkin: '2026-03-08', checkout: '2026-03-11', dateFlexibilityDays: 1 });
  assert.equal(dst.checkinOffsetDays, 1);
  assert.equal(dst.checkoutOffsetDays, 1);
});

test('an exact-date search with partial stays enabled retains labeled partial stays and excludes ambiguous results', () => {
  const requested = { checkin: '2026-12-15', checkout: '2026-12-18' };
  const rows = [
    { id: 'exact', listingParamOverrides: null },
    { id: 'alternate', listingParamOverrides: { checkin: '2026-12-16', checkout: '2026-12-19' } },
    { id: 'partial-stay', listingParamOverrides: { checkin: '2026-12-15', checkout: '2026-12-17' }, structuredDisplayPrice: { primaryLine: { price: '$200', qualifier: 'for 2 nights' } } },
    { id: 'incomplete-dates', listingParamOverrides: { checkin: '2026-12-15' } },
    { id: 'invalid-dates', listingParamOverrides: { checkin: '2026-12-15', checkout: 'invalid' } },
    { id: 'wrong-night-count', structuredDisplayPrice: { primaryLine: { price: '$200', qualifier: 'for 2 nights' } } },
  ].map(row => {
    const pricing = extractPricing(row, { ...requested, currency: 'USD' });
    return { id: row.id, pricing, availability: describeAvailability(pricing, requested) };
  });
  const result = filterByAvailability(rows, true, true);
  assert.deepEqual(result.searchResults.map(row => row.id), ['exact', 'alternate', 'partial-stay']);
  assert.deepEqual(result.availabilityFilter, { applied: true, excludedResults: 3, partialStayResults: 2 });
  const partial = result.searchResults.find(row => row.id === 'partial-stay');
  assert.equal(partial.availability.matchType, 'partial_stay');
  assert.match(partial.availability.label, /Partial stay: 2 of 3 requested nights/);
  assert.equal(partial.availability.matchedNights, 2);
  assert.equal(partial.availability.missingRequestedNights, 1);
  assert.equal(partial.pricing.checkin, '2026-12-15');
  assert.equal(partial.pricing.checkout, '2026-12-17');
  assert.equal(partial.pricing.nights, 2);
  assert.equal(partial.pricing.stayTotal, 200);
  const shifted = result.searchResults.find(row => row.id === 'alternate');
  assert.equal(shifted.availability.matchedNights, 3);
  assert.equal(shifted.availability.coveredRequestedNights, 2);
  assert.equal(shifted.availability.matchesRequestedDates, false);
  assert.equal(rows.length, 6, 'Input results must remain intact');
  const off = filterByAvailability(rows, true);
  assert.deepEqual(off.searchResults.map(row => row.id), ['exact']);
  assert.equal(off.availabilityFilter.partialStayResults, 0);
});

test('a fully unavailable page remains empty instead of returning alternative dates', () => {
  const requested = { checkin: '2026-12-15', checkout: '2026-12-18' };
  const pricing = extractPricing({ listingParamOverrides: { checkin: '2026-12-20', checkout: '2026-12-23' } }, { ...requested, currency: 'USD' });
  const rows = [{ pricing, availability: describeAvailability(pricing, requested) }];
  assert.deepEqual(filterByAvailability(rows, true).searchResults, []);
  const undated = filterByAvailability(rows, false);
  assert.equal(undated.searchResults.length, 1);
  assert.deepEqual(undated.availabilityFilter, { applied: false, excludedResults: 0, partialStayResults: 0 });
});

test('the partial-stay toggle also excludes partial overlaps inside a flexibility window when off', () => {
  const requested = { checkin: '2027-01-01', checkout: '2027-01-05', dateFlexibilityDays: 3 };
  const pricing = { checkin: '2027-01-02', checkout: '2027-01-05', datesMatchPrice: true };
  const rows = [{ pricing, availability: describeAvailability(pricing, requested) }];
  assert.equal(rows[0].availability.withinRequestedWindow, true);
  assert.equal(filterByAvailability(rows, true, false).searchResults.length, 0);
  assert.equal(filterByAvailability(rows, true, true).searchResults.length, 1);
});

test('explicit flexibility retains nearby stays but excludes ones beyond the window', () => {
  const requested = { checkin: '2026-12-15', checkout: '2026-12-18', dateFlexibilityDays: 3 };
  const rows = [
    { checkin: '2026-12-12', checkout: '2026-12-15' },
    { checkin: '2026-12-19', checkout: '2026-12-22' },
  ].map(dates => {
    const pricing = extractPricing({ listingParamOverrides: dates }, { ...requested, currency: 'USD' });
    return { pricing, availability: describeAvailability(pricing, requested) };
  });
  const result = filterByAvailability(rows, true);
  assert.equal(result.searchResults.length, 1);
  assert.equal(result.searchResults[0].pricing.checkin, '2026-12-12');
  assert.equal(result.availabilityFilter.excludedResults, 1);
});

test('overlap counts requested nights and excludes the departure night', () => {
  const requested = { checkin: '2027-01-15', checkout: '2027-01-18' };
  const suffix = describeAvailability({ checkin: '2027-01-16', checkout: '2027-01-18' }, requested);
  assert.equal(suffix.matchType, 'partial_stay');
  assert.equal(suffix.coveredRequestedNights, 2);
  const outside = describeAvailability({ checkin: '2027-01-18', checkout: '2027-01-20' }, requested);
  assert.equal(outside.matchType, 'alternative_dates');
  assert.equal(outside.coveredRequestedNights, 0);
  const extended = describeAvailability({ checkin: '2027-01-14', checkout: '2027-01-19' }, requested);
  assert.equal(extended.matchType, 'alternative_dates');
  assert.equal(extended.coveredRequestedNights, 3);
  assert.equal(extended.matchedNights, 5);
  assert.match(extended.label, /Alternative dates/);
});
