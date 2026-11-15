import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dateNights, extractPricing, resolveCurrency } from './dist/pricing.js';

const { cases } = JSON.parse(readFileSync(new URL('./test/fixtures/pricing.json', import.meta.url), 'utf8'));
const parseCase = name => extractPricing(cases[name].row, cases[name].context);

test('rounded USD headline remains approximate instead of inventing an exact total', () => {
  const price = parseCase('usd');
  assert.equal(price.currency, 'USD');
  assert.equal(price.stayTotal, 480);
  assert.equal(price.stayTotalSource, 'display');
  assert.equal(price.stayTotalIsApproximate, true);
  assert.equal(price.baseNightlyRate, 159.97);
  assert.equal(price.averageNightlyTotal, 160);
  assert.equal(price.breakdown[0].amount, 479.91);
  assert.equal(price.taxesIncluded, null);
  assert.equal(price.feesIncluded, null);
  assert.equal(price.datesSource, 'requested');
  assert.equal(price.nights, 3);
});

test('explicit breakdown total preserves cents and tax status for suggested dates', () => {
  const price = parseCase('undated');
  assert.equal(price.stayTotal, 366.5);
  assert.equal(price.stayTotalSource, 'breakdown');
  assert.equal(price.stayTotalIsApproximate, false);
  assert.equal(price.baseNightlyRate, 226);
  assert.equal(price.averageNightlyTotal, 183.25);
  assert.equal(price.originalStayTotal, 452);
  assert.equal(price.discounts[0].amount, -85.5);
  assert.equal(price.taxesIncluded, false);
  assert.equal(price.datesSource, 'airbnb_suggested');
  assert.equal(price.checkin, '2026-12-01');
  assert.equal(price.checkout, '2026-12-03');
});

test('EUR prices retain the returned currency and do not use the USD rate', () => {
  const price = parseCase('eur');
  assert.equal(price.currency, 'EUR');
  assert.equal(price.currencyMatchesRequest, true);
  assert.equal(price.baseNightlyRate, 145.13);
  assert.equal(price.stayTotal, 436);
  assert.equal(price.averageNightlyTotal, 145.33);
});

test('embedded price reductions remain separate from line-item discounts', () => {
  const price = parseCase('price_reduction');
  assert.equal(price.discounts.length, 0);
  assert.equal(price.priceReductions[0].originalAmount, 866);
  assert.equal(price.priceReductions[0].currentAmount, 657);
  assert.equal(price.priceReductions[0].amount, 209);
  assert.equal(price.stayTotal, 657);
  assert.equal(price.baseNightlyRate, 219);
});

test('fees, taxes, and discounts preserve signs without double counting totals', () => {
  const price = extractPricing({ structuredDisplayPrice: {
    primaryLine: { price: '$390', qualifier: 'for 3 nights', accessibilityLabel: '$390 for 3 nights' },
    explanationData: { priceDetails: [{ items: [
      { description: '3 nights x $100.00', priceString: '$300.00' },
      { description: 'Cleaning fee', priceString: '$50.00' },
      { description: 'Resort fee', priceString: '$30.00' },
      { description: 'Taxes', priceString: '$30.00' },
      { description: 'Weekly discount', priceString: '-$20.00' },
      { description: 'Total', priceString: '$390.00', accessibilityLabel: '$390 total including all fees and taxes' },
    ] }] },
  } }, { currency: 'USD' });
  assert.equal(price.stayTotal, 390);
  assert.equal(price.averageNightlyTotal, 130);
  assert.deepEqual(price.fees.map(item => item.amount), [50, 30]);
  assert.equal(price.taxes[0].amount, 30);
  assert.equal(price.discounts[0].amount, -20);
  assert.equal(price.feesIncluded, true);
  assert.equal(price.taxesIncluded, true);
  assert.equal(price.checkin, null);
});

test('nightly-only display never becomes a stay total by multiplication', () => {
  const price = extractPricing({ structuredDisplayPrice: {
    primaryLine: { price: '$100', qualifier: 'night', accessibilityLabel: '$100 per night' },
  } }, { currency: 'USD', checkin: '2026-12-01', checkout: '2026-12-04' });
  assert.equal(price.baseNightlyRate, null);
  assert.equal(price.displayedNightlyRate, 100);
  assert.equal(price.nights, 3);
  assert.equal(price.stayTotal, null);
  assert.equal(price.averageNightlyTotal, null);
});

test('a fee with total in its label is not mistaken for the stay total', () => {
  const price = extractPricing({ structuredDisplayPrice: {
    primaryLine: { price: '$250', qualifier: 'for 2 nights' },
    explanationData: { priceDetails: [{ items: [null, { description: 'Total cleaning fee', priceString: '$50.00' }] }] },
  } }, { currency: 'USD' });
  assert.equal(price.stayTotal, 250);
  assert.equal(price.stayTotalIsApproximate, true);
  assert.equal(price.fees[0].amount, 50);
});

test('missing or conflicting metadata never turns a dollar symbol into a currency code', () => {
  assert.equal(resolveCurrency({}), null);
  assert.equal(resolveCurrency({ root: [['CoreGuestSpaToken', { serverDeterminedCurrency: 'USD' }], ['BootstrapDataToken', { serverDeterminedCurrency: 'USD' }]] }), 'USD');
  assert.equal(resolveCurrency({ root: [['a', { serverDeterminedCurrency: 'USD' }], ['b', { serverDeterminedCurrency: 'CAD' }]] }), null);
  const price = extractPricing(cases.usd.row, { currency: null, requestedCurrency: 'USD' });
  assert.equal(price.currency, null);
  assert.equal(price.currencyMatchesRequest, null);
  assert.equal(price.averageNightlyTotal, null);
});

test('currency and date overrides are explicit, including night-count mismatches', () => {
  const row = structuredClone(cases.usd.row);
  row.listingParamOverrides = { checkin: '2026-12-05', checkout: '2026-12-07' };
  const price = extractPricing(row, { ...cases.usd.context, currency: 'CAD' });
  assert.equal(price.currencyMatchesRequest, false);
  assert.equal(price.datesSource, 'airbnb_override');
  assert.equal(price.nights, 3);
  assert.equal(price.datesMatchPrice, false);
  assert.equal(price.notes.length, 2);
});

test('unfamiliar number formats and missing prices remain unknown', () => {
  const price = extractPricing({ structuredDisplayPrice: {
    primaryLine: { price: '€1.234,56', qualifier: 'for 3 nights' },
  } }, { currency: 'EUR' });
  assert.equal(price.stayTotal, null);
  const missing = extractPricing({}, { currency: null });
  assert.equal(missing.nights, null);
  assert.equal(missing.stayTotal, null);
  assert.equal(missing.taxesIncluded, null);
});

test('currency precision and grouped amounts are retained', () => {
  const price = extractPricing({ structuredDisplayPrice: {
    primaryLine: { price: '¥12,345', qualifier: 'for 2 nights' },
  } }, { currency: 'JPY' });
  assert.equal(price.stayTotal, 12345);
  assert.equal(price.averageNightlyTotal, 6173);
});

test('dates use calendar validation and UTC night counts', () => {
  assert.equal(dateNights('2026-03-07', '2026-03-10'), 3);
  assert.equal(dateNights('2028-02-28', '2028-03-01'), 2);
  for (const pair of [['2026-02-29', '2026-03-02'], ['2026-12-04', '2026-12-01'], ['2026-12-01', '2026-12-01'], ['2026-12-01', undefined]]) {
    assert.equal(dateNights(...pair), null);
  }
});
