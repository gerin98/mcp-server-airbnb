[![downloads](https://img.shields.io/npm/dm/@openbnb/mcp-server-airbnb)](https://www.npmjs.com/package/@openbnb/mcp-server-airbnb)

# Airbnb Search & Listings - MCP Bundle (MCPB)

A comprehensive MCP Bundle for searching Airbnb listings with advanced filtering capabilities and detailed property information retrieval. Built as a Model Context Protocol (MCP) server packaged in the MCP Bundle (MCPB) format for easy installation and use with compatible AI applications.

---

## 🚀 Prefer not to run a local server? Try [openbnb.ai](https://openbnb.ai/)

> **👉 [openbnb.ai](https://openbnb.ai/) is a hosted MCP server that solves the same problem — searching Airbnb listings — without any local setup.**

If you don't want to deal with installing and running this server yourself, **[openbnb.ai](https://openbnb.ai/)** is a separate, fully-hosted alternative you can connect to directly from your MCP client. It goes beyond what this open-source server offers:

- ✅ **Zero setup** — no Node, no `npx`, no config files, no updates to manage
- ✅ **Advanced filters** — richer search controls beyond the base tools here
- ✅ **MCP UI** — interactive UI components for browsing results, not just plain text
- ✅ **Managed & maintained** — kept running for you

Head to **[openbnb.ai](https://openbnb.ai/)** for setup instructions and the connection details for your MCP client.

If you'd rather self-host the open-source server, read on.

---

## Features

### 🔍 Advanced Search Capabilities
- **Location-based search** with support for cities, states, and regions
- **International location support** via client-side geocoding, so non-US queries (e.g. "Paris, France", "Copenhagen, Denmark") return results in the right city
- **Google Maps Place ID** integration for precise location targeting
- **Room type filtering** for entire homes, private rooms, shared rooms, or hotel rooms
- **Date filtering** with check-in and check-out date support
- **Flexible availability search** around requested dates, with the matched dates reported for each listing
- **Guest configuration** including adults, children, infants, and pets
- **Price range filtering** with minimum and maximum price constraints
- **Bedroom, bed, and bathroom filtering** with independent minimum counts
- **Amenity filtering** for Wi-Fi, kitchens, parking, pools, and more, with multiple requirements per search
- **Pagination support** for browsing through large result sets

### 🏠 Detailed Property Information
- **Comprehensive listing details** including amenities, policies, and highlights
- **Location information** with coordinates and neighborhood details
- **House rules and policies** for informed booking decisions
- **Property descriptions** and key features
- **Direct links** to Airbnb listings for easy booking

### 🛡️ Security & Compliance
- **Robots.txt compliance** with configurable override for testing
- **Request timeout management** to prevent hanging requests
- **Enhanced error handling** with detailed logging
- **Rate limiting awareness** and respectful API usage
- **Secure configuration** through MCPB user settings

## Installation

### For Codex (local checkout)

Install dependencies and build from the repository directory:

```bash
npm ci
```

`npm ci` runs the build automatically. Register the built server using absolute
paths so Codex can start it from any working directory:

```bash
codex mcp add airbnb -- /absolute/path/to/node /absolute/path/to/mcp-server-airbnb/dist/index.js
codex mcp get airbnb
```

Use `command -v node` to find your Node executable. With Homebrew's keg-only
Node 22 on Apple Silicon, it is typically `/opt/homebrew/opt/node@22/bin/node`;
add `/opt/homebrew/opt/node@22/bin` to your shell's `PATH` to run `npm`.

This configuration runs your local checkout. After source changes, run
`npm run build` and reconnect the MCP server to load the updated code.

Robots.txt compliance is enabled by default and can block searches. For testing,
the tools accept `ignoreRobotsText: true` per request. The server also supports
the `--ignore-robots-txt` startup flag described below.

### For Claude Desktop
This extension is packaged as an MCP Bundle (`.mcpb`) file. To install:

1. Download the `.mcpb` file from the [latest release](https://github.com/openbnb-org/mcp-server-airbnb/releases/latest)
2. Open the file — Claude Desktop will show an installation dialog
3. Configure the extension settings as needed

To ignore robots.txt, open Claude Desktop settings, navigate to the extension, and enable the **Ignore robots.txt** toggle.

### For Cursor, etc.

Before starting make sure [Node.js](https://nodejs.org/) is installed on your desktop for `npx` to work.
1. Go to: Cursor Settings > Tools & Integrations > New MCP Server

2. Add one the following to your `mcp.json`:
    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb"
          ]
        }
      }
    }
    ```

    To ignore robots.txt for all requests, use this version with `--ignore-robots-txt` args

    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb",
            "--ignore-robots-txt"
          ]
        }
      }
    }
    ```
3. Restart.


## Configuration

The extension provides the following user-configurable options:

### Ignore robots.txt
- **Type**: Boolean (checkbox)
- **Default**: `false`
- **Description**: Bypass robots.txt restrictions when making requests to Airbnb
- **Recommendation**: Keep disabled unless needed for testing purposes

### Disable third-party geocoding
- **Type**: Boolean (checkbox)
- **Environment variable**: `DISABLE_GEOCODING`
- **Default**: `false`
- **Description**: Skip the Photon/Nominatim geocoding step and let Airbnb resolve the location string on its own. Enabling this restores the pre-PR behavior — every search goes only to `airbnb.com`, no third-party calls.
- **Recommendation**: Keep disabled unless you specifically need zero third-party outbound traffic. With it enabled, non-US searches could return incorrect results. See [External Services](#external-services).

## Tools

### `airbnb_list_amenities`

Discover the amenity filters this server supports. No parameters are required;
call it with `{}` or omit the arguments. It works offline and returns an
`amenities` array with each filter's `name`, readable `label`, and `description`.
Use the names directly in `airbnb_search`'s `amenities` array.

For example, one entry is:

```json
{
  "name": "pool",
  "label": "Pool",
  "description": "Access to a pool, which may be shared. Check seasonal availability, heating, and access hours."
}
```

This catalog lists supported search options. It does not determine whether a
particular location or property offers them. Use `airbnb_search` to find matching
stays, then `airbnb_listing_details` to inspect a property's amenities.

### `airbnb_search`

Search for Airbnb listings with comprehensive filtering options.

**Parameters:**
- `location` (required): Location to search (e.g., "San Francisco, CA"). When supplied without `placeId`, the server geocodes this string client-side via Photon/Nominatim — see [External Services](#external-services).
- `placeId` (optional): Google Maps Place ID. Overrides `location` and skips client-side geocoding entirely (no third-party calls).
- `checkin` (optional): Check-in date in YYYY-MM-DD format; supply together with `checkout`
- `checkout` (optional): Check-out date in YYYY-MM-DD format; must be after `checkin`
- `dateFlexibilityDays` (optional): `0` (exact dates), `1`, `2`, `3`, `7`, or `14`. Positive values request dates within that many days on either side of the requested check-in/check-out, and require both dates. Omit for exact dates.
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `minPrice` (optional): Minimum nightly price in the selected currency; uses Airbnb's nightly-price filter
- `maxPrice` (optional): Maximum nightly price in the selected currency; uses Airbnb's nightly-price filter
- `currency` (optional): Requested three-letter uppercase currency code, such as `USD`, `EUR`, or `GBP`. Omit to use Airbnb's default. Output reports the actual resolved currency, including any mismatch with the request.
- `minBedrooms` (optional): Minimum number of bedrooms; a non-negative whole number. Omit or use `0` for any.
- `minBeds` (optional): Minimum number of beds, independent of bedrooms and guest count; a non-negative whole number. Omit or use `0` for any.
- `minBathrooms` (optional): Minimum number of bathrooms; a non-negative whole number. Omit or use `0` for any. Fractional minimums such as `1.5` are rejected because Airbnb truncates them.
- `amenities` (optional): Array of required amenity names (see below). All selected amenities are requested together. Omit or use `[]` for unrestricted searches. Duplicates are ignored; unknown names are rejected.
- `cursor` (optional): Pagination cursor for browsing results
- `propertyType` (optional): Filter by room type — `entire_home`, `private_room`, `shared_room`, or `hotel_room`. The parameter name is retained for compatibility; it does not filter building types such as house or apartment. Omit for any room type; unsupported values are rejected.
- `ignoreRobotsText` (optional): Override robots.txt for this request

**Returns:**
- Search results with property details, pricing, and direct links
- Pagination information for browsing additional results
- Search URL for reference
- Retrieval timestamp (`retrievedAt`) and structured `pricing` for each listing
- `availability` describing how each result's quoted dates compare with your request
- `availabilityFilter.applied`, `availabilityFilter.excludedResults`, and `availabilityFilter.partialStayResults`, reporting date filtering and how many results are excluded or partial stays

To search for your stay, supply `checkin` and `checkout`. Omit
`dateFlexibilityDays` (or use `0`) to request exact dates from Airbnb. Check-in is
included; checkout is the departure date, so its night is not part of the stay.
Partial stays returned by Airbnb are retained and explicitly labeled. Unknown
override dates and inconsistent quoted night counts are excluded from dated
searches. Dates without an override inherit the dates sent to Airbnb.

Each result has an `availability.matchType` and a readable `availability.label`:

- `exact_dates`: the full requested stay.
- `partial_stay`: covers some, but not all, requested nights. For example,
  “Partial stay: 2 of 3 requested nights; quoted stay 2027-01-15 to 2027-01-17
  (2 nights).” A shifted stay may also include nights outside your request;
  `matchedNights` and `coveredRequestedNights` make that distinction explicit.
- `alternative_dates`: different dates accepted within an explicitly requested
  flexibility window; never labeled as an exact match.
- `suggested_dates`: Airbnb chose dates because none were requested.
- `unknown`: the available date information cannot be reliably compared.

Always show the label for partial or alternative stays, and use the price for
their actual quoted dates. The `requestedNights`, `matchedNights`,
`coveredRequestedNights`, and `missingRequestedNights` fields describe coverage
without implying that a shorter quote pays for the full requested stay.

Partial stays are retained even when exact dates are requested. Other
alternative dates must fall within an explicitly selected flexibility window.
The original pagination cursor is retained even if filtering empties a page;
an empty page does not establish that the entire destination has no availability.

For example, to search around a three-night trip with up to three days of date
flexibility:

```json
{
  "location": "Boston, MA",
  "checkin": "2027-01-15",
  "checkout": "2027-01-18",
  "dateFlexibilityDays": 3,
  "adults": 2
}
```

Each result's `availability` includes the requested and matched dates,
`matchesRequestedDates`, `withinRequestedWindow`, the check-in/check-out offsets
in days, and `matchesRequestedStayLength`. Date comparisons are `null` when
there is no valid date pair to compare. Flexible results may have a different
stay length; the associated `pricing` always uses the dates quoted for that
listing. Links preserve those matched dates, the requested guest counts, and the
returned currency.

Availability here is based on Airbnb search results, not a separate listing
calendar check. This feature does not provide a calendar of every available day.
Without requested dates, Airbnb's suggested dates are labeled in `pricing` and
are not treated as a match to an unspecified trip.

Each search result preserves the existing `structuredDisplayPrice` text and adds
a `pricing` object. Monetary amounts are numbers in major units of `currency`
(for example, dollars rather than cents). Missing information is `null`.

| Field | Meaning |
| --- | --- |
| `currency`, `requestedCurrency`, `currencyMatchesRequest` | Actual currency from Airbnb's page metadata, requested currency, and whether they match. A `$` symbol alone never determines the currency. |
| `checkin`, `checkout`, `datesSource` | Effective dates and whether they were `requested`, `airbnb_suggested`, `airbnb_override`, or `unknown`. Undated searches do not mean tonight. |
| `nights`, `datesMatchPrice` | Number of nights quoted and whether it agrees with the date range. Any mismatch is also recorded in `notes`. |
| `baseNightlyRate` | The rate in Airbnb's “N nights × amount” breakdown, before separately itemized charges or discounts. |
| `displayedNightlyRate` | A headline explicitly quoted per night, when available. It may include fees and is kept separate from the base rate. |
| `stayTotal`, `stayTotalSource`, `stayTotalIsApproximate` | Total from an explicit breakdown total when available; otherwise the displayed stay total, marked approximate because headlines may be rounded. The server never invents a total by multiplying the base rate. |
| `averageNightlyTotal` | `stayTotal / nights`, rounded to the currency's precision. It inherits the total's approximation and tax/fee inclusion status; it is not necessarily an all-in nightly cost. |
| `originalStayTotal` | The displayed pre-reduction total, when available; it may also be rounded. |
| `fees`, `taxes`, `discounts` | Itemized entries with labels, numeric amounts, and original display strings. Discounts retain their signs. Empty arrays mean no entries were provided, not zero charges. |
| `priceReductions` | Comparisons between original and current breakdown amounts. These are not additional discount line items to subtract again. |
| `taxesIncluded`, `feesIncluded` | `true` or `false` only when Airbnb explicitly says so; otherwise `null`. |
| `breakdown`, `display`, `notes` | Unflattened price items, original headline text, disclaimers, and detected mismatches. |

For example, a headline of `$367 for 2 nights` can have an explicit breakdown
total of `$366.50 total before taxes`. That yields `stayTotal: 366.5`,
`averageNightlyTotal: 183.25`, `taxesIncluded: false`, and
`stayTotalIsApproximate: false`. If only the rounded headline is available, the
total stays `367` and is marked approximate. These are search quotes, not a final
checkout charge. The listing-details tool continues to return property details;
structured pricing is currently supplied by search.

For example, pass `{"location":"Boston, MA","minBedrooms":2,"minBeds":3,"minBathrooms":2}`
to search for stays with at least two bedrooms, three beds, and two bathrooms. These filters
are applied by Airbnb before pagination and can be combined with dates, guests,
price, and room type filters.

Call `airbnb_list_amenities` for descriptions, or use names from this list:

```text
wifi, kitchen, washer, dryer, air_conditioning, heating, dedicated_workspace,
tv, hair_dryer, iron, pool, hot_tub, free_parking, ev_charger, crib, king_bed,
gym, bbq_grill, breakfast, indoor_fireplace, self_check_in, smoking_allowed,
smoke_alarm, carbon_monoxide_alarm
```

For example, search for at least two bedrooms, three beds, two bathrooms, Wi-Fi, a kitchen,
and a washer:

```json
{
  "location": "Boston, MA",
  "minBedrooms": 2,
  "minBeds": 3,
  "minBathrooms": 2,
  "amenities": ["wifi", "kitchen", "washer"]
}
```

The server translates these names to Airbnb's `amenities[]` search parameters.
Filters use Airbnb's amenity categories; they do not guarantee exclusive use of
facilities such as pools or gyms. Check listing details for those specifics.

### `airbnb_listing_details`

Get public details from a full Airbnb listing URL or listing ID.

```json
{
  "url": "https://www.airbnb.com/rooms/53610715?check_in=2027-01-15&check_out=2027-01-18&adults=2",
  "currency": "USD"
}
```

**Parameters:**

- `url` or `id` (one required): Full Airbnb `/rooms/ID` URL or numeric ID as a string. Regional Airbnb domains are accepted and normalized to `www.airbnb.com`. Shortened share links are not supported; use the full listing URL. If both are provided, they must refer to the same listing.
- `checkin`, `checkout` (optional): Paired YYYY-MM-DD dates; checkout must be after checkin.
- `adults` (optional): Whole number at least 1 (default: 1).
- `children`, `infants`, `pets` (optional): Nonnegative whole numbers (default: 0).
- `currency` (optional): Three-letter uppercase code such as USD or EUR.
- `ignoreRobotsText` (optional): Override robots.txt for this request.

Dates (`check_in`/`check_out`), guest counts and currency are read from the URL.
Explicit arguments override those URL values. Tracking parameters are discarded.

**Returns:**

- `listingId`, `listingUrl` and `retrievedAt`.
- `listing`: structured title, full page description, room/capacity summary,
  sleeping arrangements, amenity groups with `available` flags, host details,
  listing ratings and category scores, photos, house rules, safety information,
  accessibility features, guest requirements and location. Location retains
  `isExactLocation` when supplied; approximate coordinates are not an exact address.
- `listing.booking`: when dates are supplied, a separate live quote lookup for
  that listing, exact date range, and all guest counts. It returns the availability
  result, pricing, any cancellation summary, and the time checked. Without dates,
  `quoteStatus` is `not_requested` and only embedded page information is returned.
- `listing.coverage`: missing fields and explicit scope. This returns information
  from the public page and dated lookup, not the full review history or availability calendar.
- `details`: the existing section array, retained for compatibility, including
  category-keyed `seeAllAmenitiesGroups` and unavailable-amenity labels.

Use `airbnb_search` for dated search quotes and clearly labeled partial stays.

**Dated booking results:**

| Field | Meaning |
| --- | --- |
| `quoteStatus` | `checked` for a supported response with a matching date label and price night count (when present); `error` or `blocked` if the lookup could not be verified. |
| `available`, `availabilityStatus` | Whether this exact stay and guest combination is available. An unavailable stay can reflect a minimum-stay restriction; it does not mean every night is booked. |
| `datesVerified`, `verificationSource` | A successful dated request, with the returned date label checked against the requested dates. This is not a reservation. |
| `message`, `unavailabilityReason` | Airbnb's explanation, such as unavailable dates or a minimum stay of 10 nights. |
| `pricing.stayTotal`, `stayTotalSource` | The explicit breakdown total when available, otherwise the displayed total with its approximation flag. The total is never calculated by multiplying rounded nightly rates. |
| `pricing.quotedNightlyRate`, `averageNightlyTotal` | Airbnb's quoted nightly figure and the total divided by the quoted nights. `baseNightlyRate` stays null because the quoted rate can include fees. |
| `pricing.feesIncluded`, `feesItemized`, `taxesIncluded`, `taxesItemized` | Explicit inclusion and itemization signals. Empty fee/tax arrays do not mean zero fees/taxes. |
| `currency`, `currencySource` | The explicit currency passed to the quote endpoint (`quote_request`). The response does not independently echo an ISO currency code. Defaults to the page's resolved currency when omitted. |
| `cancellationPolicy` | The returned cancellation summary, with `fullTermsAvailable: false`. Full refund terms, deadline times and time zones must be confirmed on Airbnb. |
| `checkedAt`, `guests` | When the live lookup ran and the guest counts it used. Quotes are not cached. |

If the extra lookup fails, static listing details are still returned. `available`
and `pricing` remain null, `availabilityStatus` is `unknown`, and `datesVerified`
is false. A request failure is never reported as an unavailable stay. The lookup
respects the same robots.txt setting as the listing request. It discovers the
current operation from Airbnb's public versioned page asset; unsupported page or
response changes produce an explicit lookup error instead of a guessed quote.

## Technical Details

### Architecture
- **Runtime**: Node.js 18+
- **Protocol**: Model Context Protocol (MCP) via stdio transport
- **Format**: MCP Bundle (MCPB) v0.3
- **Dependencies**: Minimal external dependencies for security and reliability

### External Services

In addition to `airbnb.com`, the server makes geocoding requests to two third-party services to translate location queries into accurate map bounding boxes. This bypasses Airbnb's own server-side geocoder, which produces incorrect results for many non-US queries (e.g. "Paris, France" lands in Vendée; "Copenhagen, Denmark" lands in Wisconsin).

| Service | Endpoint | Used for | Notes |
| --- | --- | --- | --- |
| [Photon](https://photon.komoot.io/) | `photon.komoot.io` | Primary geocoder, called on every search without `placeId` | Free OSM-based service hosted by Komoot. One request per search. |
| [Nominatim](https://nominatim.openstreetmap.org/) | `nominatim.openstreetmap.org` | Fallback geocoder, called only when Photon does not return a bounding box | Subject to the [OSMF usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max ~1 req/sec). |

Each search sends only the `location` string from the request to the geocoder — no other request fields, no IP geolocation, no tracking identifiers. The location string itself is, of course, the same string the user typed.

**Opting out:** there are two ways to skip the geocoders:

- **Per-request:** supply an explicit `placeId`. When `placeId` is present, the server uses Airbnb's own place lookup directly with no third-party calls.
- **Globally:** set the environment variable `DISABLE_GEOCODING=true`. The server will skip Photon/Nominatim entirely and pass the raw location string to Airbnb. This restores the pre-PR behavior for every search and guarantees zero third-party outbound traffic — at the cost of broken results for non-US locations that Airbnb's own geocoder mishandles. Defaults to `false`.

If a geocoder is unreachable or returns no result, the server falls back to sending the location string to Airbnb directly, exactly as it did before — so the worst case for an outage is that international searches degrade to the previous (broken) behavior, not that the search fails entirely.

### Error Handling
- Comprehensive error logging with timestamps
- Graceful degradation when Airbnb's page structure changes
- Timeout protection for network requests
- Detailed error messages for troubleshooting

### Security Measures
- Robots.txt compliance by default
- Request timeout limits
- Input validation and sanitization
- Secure environment variable handling
- No sensitive data storage

### Performance
- Efficient HTML parsing with Cheerio
- Request caching where appropriate
- Minimal memory footprint
- Fast startup and response times

## Compatibility

- **Platforms**: macOS, Windows, Linux
- **Node.js**: 18.0.0 or higher
- **Claude Desktop**: 0.10.0 or higher
- **Other MCP clients**: Compatible with any MCP-supporting application

## Development

### Building from Source

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch for changes during development
npm run watch
```

### Testing

```bash
# Build, then run all suites
npm test
# Build, then run only offline tests (live cases are always skipped)
npm run test:offline
# Build, then make one live listing request over MCP
npm run test:live
```

The test suites cover fixtures and the built server over stdio:

- `test-filters.js` — offline amenity catalog discovery, consistency with search and the bundle manifest, and filter validation; optional live search checks
- `test-pricing.js` — captured price-response fixtures and edge cases covering currency, rounding, nightly versus total prices, fees, discounts, dates, and unknown tax information
- `test-availability.js` — exact and flexible date comparisons, unknown dates, window boundaries, year changes, and daylight-saving boundaries
- `test-listing.js` — listing URL validation, page extraction fixtures and MCP validation; optional broader live listing checks
- `test-booking.js` — dated quote fixtures, exact totals, cancellation summaries, request context, date matching, robots rules and failure handling
- `test-live.js` — one dated listing URL smoke test over MCP, run by `npm run test:live`
- `test-extension.js` — MCP handshake, tool listing, a search, listing details, and the geocoding paths (Photon, Nominatim fallback)
- `test-amenities.js` — amenity extraction across several live listings, checking that amenities Airbnb strikes through never appear as ones the listing offers

The extension and amenities suites hit `airbnb.com` and the geocoders over the network. These broader live suites remain outside CI.

The [Tests workflow](.github/workflows/tests.yml) runs on pull requests, pushes to
`main`, and manual dispatch. It builds and runs the offline tests on Node 22, then
runs a separate live smoke-test job with exactly one listing tool call. Neither
job needs secrets. The smoke test uses the robots.txt testing override and a
three-night stay starting 60 days ahead. It checks listing details and a verified
dated availability response; either available or unavailable is valid. It does
not require any particular price. The single tool call fetches the listing page,
its public quote-operation asset and the dated quote response.
Live failures fail their job and expose server diagnostics; Airbnb blocking CI
traffic, a removed listing, or page changes can cause that job to fail even when
the offline tests pass. The test does not retry or silently skip those failures.

To run just the search-filter tests:

```bash
npm run test:filters
# Run deterministic pricing tests:
npm run test:pricing
# Run availability comparisons and filter validation:
npm run test:availability
# Also verify room minimums and amenities against actual live listings:
AIRBNB_LIVE_TESTS=true npm run test:filters
```

The live filter tests use the robots.txt testing override and check room filters
independently and together, zero minimums, an empty amenity list, a single amenity,
and multiple amenities combined with room minimums. They also check duplicate
handling and inspect listing details for three results from each amenity search.
Room-type tests also inspect Airbnb's returned request data to verify that all
four categories are applied as room filters, without a building-type restriction.
Availability tests verify all five flexibility windows and exact dates against
Airbnb's returned request data, and check that listing links preserve quote dates.

The server can also be run directly:

```bash
# Run with robots.txt compliance (default)
node dist/index.js

# Run with robots.txt ignored (for testing)
node dist/index.js --ignore-robots-txt
```

## Legal and Ethical Considerations

- **Respect Airbnb's Terms of Service**: This extension is for legitimate research and booking assistance
- **Robots.txt Compliance**: The extension respects robots.txt by default
- **Rate Limiting**: Be mindful of request frequency to avoid overwhelming Airbnb's servers
- **Data Usage**: Only extract publicly available information for legitimate purposes

## Support

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/openbnb-org/mcp-server-airbnb/issues)
- **Documentation**: Additional documentation available in the repository
- **Community**: Join discussions about MCP and MCPB development

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read the contributing guidelines and submit pull requests for any improvements.

---

**Note**: This extension is not affiliated with Airbnb, Inc. It is an independent tool designed to help users search and analyze publicly available Airbnb listings.
