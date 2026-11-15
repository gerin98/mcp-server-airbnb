import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One listing tool call with a future date range. Either available or unavailable
// is valid, but a failed/unknown dated lookup must fail this smoke test.
// Keep this separate from the broader opt-in live suites and offline CI tests.
test('live listing URL returns useful public details over MCP', { timeout: 45000 }, async t => {
  const id = '53610715';
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 60);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 3);
  const checkin = start.toISOString().slice(0, 10);
  const checkout = end.toISOString().slice(0, 10);
  const client = new Client({ name: 'ci-live-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./dist/index.js', import.meta.url)), '--ignore-robots-txt'],
    stderr: 'pipe',
  });
  let serverLog = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', chunk => { serverLog = (serverLog + chunk).slice(-8000); });
    const result = await client.callTool({
      name: 'airbnb_listing_details',
      arguments: { url: `https://www.airbnb.com/rooms/${id}`, checkin, checkout, adults: 2, currency: 'USD' },
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    const data = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(data.listingId, id);
    assert.equal(new URL(data.listingUrl).pathname, `/rooms/${id}`);
    assert.ok(data.listing.title?.trim(), 'Missing listing title');
    assert.ok(data.listing.description?.trim(), 'Missing listing description');
    assert.ok(data.listing.amenities?.some(group => group.amenities?.length > 0), 'Missing amenities');
    assert.ok(data.listing.photos?.some(photo => photo.url?.startsWith('https://')), 'Missing photos');
    assert.equal(data.listing.coverage.source, 'public_listing_page');
    assert.ok(Array.isArray(data.details), 'Missing legacy details array');
    const booking = data.listing.booking;
    assert.equal(booking.quoteStatus, 'checked', JSON.stringify(booking));
    assert.equal(booking.datesVerified, true);
    assert.equal(typeof booking.available, 'boolean');
    assert.equal(booking.requestedCheckin, checkin);
    assert.equal(booking.requestedCheckout, checkout);
    if (booking.pricing) {
      assert.equal(booking.pricing.datesMatchPrice, true);
      assert.equal(booking.pricing.currency, 'USD');
    }
  } catch (error) {
    t.diagnostic(serverLog || 'No MCP server diagnostics captured.');
    throw error;
  } finally {
    await client.close();
  }
});
