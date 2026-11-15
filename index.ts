#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema, diagnoseJsonPath, findPdpPresentation, extractAmenities, extractHighlights, keyAmenityGroups } from "./util.js";
import robotsParser from "robots-parser";
import { AMENITIES, AMENITY_IDS } from "./amenities.js";
import { dateNights, extractPricing, resolveCurrency } from "./pricing.js";
import { describeAvailability, filterByAvailability, FLEXIBLE_DATE_FILTERS } from "./availability.js";
import { normalizeListingInput, listingSections, extractListing } from "./listing.js";
import { fetchDatedBooking } from "./booking.js";
import { discoverPartialStays as runPartialStayDiscovery, validatePartialOptions, DEFAULT_PARTIAL_SEARCHES, MAX_PARTIAL_SEARCHES } from "./partial-stays.js";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch (error) {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description: "Search for Airbnb listings with filters, pagination, and optional active shorter-stay discovery using discoverPartialStays. Provide direct links to the user. Clearly label partial stays and alternative dates using availability.label, and show the actual quoted dates and price.",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      checkin: {
        type: "string",
        description: "Start of the requested stay (YYYY-MM-DD). Supply with checkout to search availability. Enable discoverPartialStays to include clearly labeled partial-stay matches."
      },
      checkout: {
        type: "string",
        description: "End of the requested stay (YYYY-MM-DD); the checkout night is not included. Supply with checkin."
      },
      dateFlexibilityDays: {
        type: "integer",
        enum: [0, ...Object.keys(FLEXIBLE_DATE_FILTERS).map(Number)],
        description: "Search around check-in and check-out by ±1, ±2, ±3, ±7, or ±14 days. Requires both dates when greater than 0. Omit or use 0 for exact dates. Check each result's availability and pricing for the matched dates."
      },
      discoverPartialStays: {
        type: "boolean",
        default: false,
        description: "Toggle partial-stay results (default off). When on, retain Airbnb's suggested partial matches and actively search shorter stays wholly within checkin/checkout. Requires both dates; cannot be combined with cursor. Partial results show the actual dates and nights covered."
      },
      minPartialNights: {
        type: "integer",
        minimum: 1,
        default: 2,
        description: "Minimum nights for actively discovered shorter stays (default 2). Requires discoverPartialStays."
      },
      maxPartialSearches: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PARTIAL_SEARCHES,
        default: DEFAULT_PARTIAL_SEARCHES,
        description: "Maximum extra date-window searches (default 6, maximum 8). Longest shorter stays are tried first, with a 20-second discovery budget. Check partialStayDiscovery for search coverage. Requires discoverPartialStays."
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum nightly price in the selected currency (Airbnb's nightly-price filter)"
      },
      maxPrice: {
        type: "number",
        description: "Maximum nightly price in the selected currency (Airbnb's nightly-price filter)"
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
        description: "Requested currency code, e.g. USD, EUR, or GBP. Prices report the currency actually returned by Airbnb; omit to use Airbnb's default."
      },
      minBedrooms: {
        type: "integer",
        minimum: 0,
        description: "Minimum number of bedrooms (whole number; omit or use 0 for any)"
      },
      minBeds: {
        type: "integer",
        minimum: 0,
        description: "Minimum number of beds, independently of bedrooms or guest count (whole number; omit or use 0 for any)"
      },
      minBathrooms: {
        type: "integer",
        minimum: 0,
        description: "Minimum number of bathrooms (whole number; omit or use 0 for any). Fractional minimums are not supported by Airbnb."
      },
      amenities: {
        type: "array",
        items: { type: "string", enum: Object.keys(AMENITY_IDS) },
        description: "Required amenities, e.g. ['wifi', 'kitchen', 'free_parking']. Use airbnb_list_amenities for labels and descriptions. All selected amenities are requested together. Omit or use [] for any; duplicates are ignored."
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
      },
      propertyType: {
        type: "string",
        enum: ["entire_home", "private_room", "shared_room", "hotel_room"],
        description: "Filter by room type: 'entire_home' (entire homes/apartments), 'private_room' (private rooms), 'shared_room' (shared/dorm-style rooms), 'hotel_room' (hotel rooms). The parameter name is retained for compatibility; it does not select building types such as house or apartment."
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["location"]
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description: "Get public details from an Airbnb listing URL or ID: description, rooms, amenities, host, photos, ratings, location, rules and safety information. With checkin and checkout, also check live availability and a dated quote for the supplied guests, including nightly/total prices and any cancellation summary. Clearly distinguish checked, unavailable and failed/unknown quotes; do not treat the quote as a reservation. Provide a direct listing link.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID (provide id or url)"
      },
      url: {
        type: "string",
        description: "Full Airbnb listing URL containing /rooms/ID. Dates, guest counts and currency are read from the URL; explicit arguments override them. Short share links are not supported."
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
        description: "Requested currency code, for example USD or EUR"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "integer",
        minimum: 1,
        description: "Number of adults"
      },
      children: {
        type: "integer",
        minimum: 0,
        description: "Number of children"
      },
      infants: {
        type: "integer",
        minimum: 0,
        description: "Number of infants"
      },
      pets: {
        type: "integer",
        minimum: 0,
        description: "Number of pets"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    anyOf: [{ required: ["id"] }, { required: ["url"] }]
  }
};

const AIRBNB_LIST_AMENITIES_TOOL: Tool = {
  name: "airbnb_list_amenities",
  description: "List supported amenity search filters with names, labels, and descriptions. Use the names in airbnb_search. This local catalog does not report availability at a location or property; use airbnb_listing_details for a property's amenities.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
  AIRBNB_LIST_AMENITIES_TOOL,
] as const;

// Utility functions
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

// Geocode location using Photon (fast, no rate limits) with Nominatim fallback.
// This bypasses Airbnb's broken server-side geocoding for non-US locations.
// Photon doesn't rank by importance, so we fetch multiple results and prefer
// cities/states/countries over hamlets/houses/POIs.
const PHOTON_TYPE_PRIORITY: Record<string, number> = {
  country: 1, state: 2, county: 3, city: 4, district: 5,
  locality: 6, street: 7, house: 8, other: 9,
};

function pickBestPhotonFeature(features: any[]): any | null {
  // Pick the feature with the highest-priority type (city > hamlet > house etc).
  // Don't filter by extent here — the best match (e.g. Stockholm, Sweden) may
  // lack an extent, and we'll fall back to Nominatim for the bbox.
  if (!features || features.length === 0) return null;

  return features.reduce((best: any, f: any) => {
    const bestPri = PHOTON_TYPE_PRIORITY[best.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    const fPri = PHOTON_TYPE_PRIORITY[f.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    return fPri < bestPri ? f : best;
  });
}

async function geocodeLocation(location: string): Promise<{
  ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string;
  displayName: string;
} | null> {
  let extent: number[] | null = null;
  let displayName = location;

  // Try Photon first — fast, no strict rate limits, OSM data.
  try {
    log('info', 'Geocoding location via Photon', { location });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json() as any;
      const feature = pickBestPhotonFeature(data?.features ?? []);
      if (feature) {
        if (feature.properties?.extent?.length === 4) {
          extent = feature.properties.extent; // [west_lng, north_lat, east_lng, south_lat]
        }
        displayName = feature.properties?.name || location;
        log('info', 'Photon selected feature', {
          location,
          type: feature.properties?.type,
          name: feature.properties?.name,
          country: feature.properties?.country,
          hasExtent: !!extent,
        });
      }
    }
  } catch (error) {
    log('warn', 'Photon geocoding failed', {
      location,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to Nominatim if Photon didn't return a bbox.
  // Nominatim ranks by importance so it handles ambiguous names well.
  // Nominatim usage policy requires an identifying User-Agent (not a browser UA).
  // See https://operations.osmfoundation.org/policies/nominatim/
  if (!extent) {
    try {
      log('info', 'Falling back to Nominatim for geocoding', { location });
      const nomController = new AbortController();
      const nomTimeout = setTimeout(() => nomController.abort(), 5000);
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
      let nomResponse;
      try {
        nomResponse = await fetch(nomUrl, {
          headers: {
            "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
            "Accept": "application/json",
          },
          signal: nomController.signal,
        });
      } finally {
        clearTimeout(nomTimeout);
      }
      if (nomResponse.ok) {
        const nomResults = await nomResponse.json() as any[];
        if (nomResults?.[0]?.boundingbox?.length === 4) {
          const bb = nomResults[0].boundingbox; // [south_lat, north_lat, west_lng, east_lng]
          extent = [parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3]), parseFloat(bb[0])];
          displayName = nomResults[0].display_name?.split(",")?.[0] || location;
          log('info', 'Nominatim fallback succeeded', { location, extent });
        }
      }
    } catch (nomError) {
      log('warn', 'Nominatim fallback also failed', { location });
    }
  }

  if (!extent || extent.length !== 4) {
    log('warn', 'No bounding box from either geocoder', { location });
    return null;
  }

  // Expand bounding box by 25% in each direction (minimum 0.1°, ~11km)
  // to capture suburbs, beaches, and surrounding areas. OSM returns tight
  // administrative boundaries (e.g., Paris = just the arrondissements,
  // Pensacola = city limits without the beach on the barrier island).
  const swLat = extent[3];
  const neLat = extent[1];
  const swLng = extent[0];
  const neLng = extent[2];
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const coords = {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
    displayName,
  };

  log('info', 'Geocoded successfully (with 25% padding)', { location, coords });
  return coords;
}

// Airbnb's room categories are distinct from its numeric building-type IDs.
const ROOM_TYPES: Record<string, string> = {
  entire_home: "Entire home/apt",
  private_room: "Private room",
  shared_room: "Shared room",
  hotel_room: "Hotel room",
};

// Configuration from environment variables (set by DXT host)
const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");
// When true, skip the Photon/Nominatim geocoding step and let Airbnb's own
// server-side geocoder handle the location string. Defaults to false so the
// fix for non-US locations stays on by default; users who want zero third-party
// outbound calls can opt out by setting DISABLE_GEOCODING=true.
const DISABLE_GEOCODING = process.env.DISABLE_GEOCODING === "true";

const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt to this User-agent. You may or may not want to run the server with '--ignore-robots-txt' args"
let robotsTxtContent = "";

// Enhanced robots.txt fetch with timeout and error handling
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log('info', 'Skipping robots.txt fetch (ignored by configuration)');
    return;
  }

  try {
    log('info', 'Fetching robots.txt from Airbnb');
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    robotsTxtContent = await response.text();
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    log('warn', 'Error fetching robots.txt, assuming all paths allowed', {
      error: error instanceof Error ? error.message : String(error)
    });
    robotsTxtContent = ""; // Empty robots.txt means everything is allowed
  }
}

function isPathAllowed(path: string): boolean {  
  if (!robotsTxtContent) {
    return true; // If we couldn't fetch robots.txt, assume allowed
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt', { path, userAgent: USER_AGENT });
    }
    
    return allowed;
  } catch (error) {
    log('warn', 'Error parsing robots.txt, allowing path', {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return true; // If parsing fails, be permissive
  }
}

async function fetchHtmlWithUserAgent(url: string, timeout: number = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.text();
  } catch (error) {
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// API handlers
async function handleAirbnbSearch(params: any, prepared?: { url: URL; timeoutMs: number }): Promise<any> {
  try { validatePartialOptions(params); }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error)); }
  const {
    location,
    placeId,
    checkin,
    checkout,
    dateFlexibilityDays = 0,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    currency,
    minBedrooms,
    minBeds,
    minBathrooms,
    amenities,
    cursor,
    propertyType,
    ignoreRobotsText = false,
  } = params;

  if (currency !== undefined && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) {
    throw new McpError(ErrorCode.InvalidParams, "currency must be a three-letter uppercase code, e.g. USD or EUR");
  }
  if ((checkin !== undefined || checkout !== undefined) && dateNights(checkin, checkout) === null) {
    throw new McpError(ErrorCode.InvalidParams, "Provide both checkin and checkout as valid YYYY-MM-DD dates, with checkout after checkin");
  }
  if (typeof dateFlexibilityDays !== "number" || !Number.isInteger(dateFlexibilityDays) ||
      (dateFlexibilityDays !== 0 && !Object.prototype.hasOwnProperty.call(FLEXIBLE_DATE_FILTERS, dateFlexibilityDays))) {
    throw new McpError(ErrorCode.InvalidParams, "dateFlexibilityDays must be one of: 0, 1, 2, 3, 7, 14");
  }
  if (dateFlexibilityDays > 0 && dateNights(checkin, checkout) === null) {
    throw new McpError(ErrorCode.InvalidParams, "dateFlexibilityDays requires both checkin and checkout");
  }

  for (const [name, value] of Object.entries({ minBedrooms, minBeds, minBathrooms })) {
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      throw new McpError(ErrorCode.InvalidParams, `${name} must be a non-negative whole number`);
    }
  }

  if (amenities !== undefined && (!Array.isArray(amenities) || amenities.some(
    (amenity: unknown) => typeof amenity !== "string" || !Object.prototype.hasOwnProperty.call(AMENITY_IDS, amenity)
  ))) {
    throw new McpError(ErrorCode.InvalidParams, `amenities must be an array containing only: ${Object.keys(AMENITY_IDS).join(", ")}`);
  }

  if (propertyType !== undefined && (typeof propertyType !== "string" || !Object.prototype.hasOwnProperty.call(ROOM_TYPES, propertyType))) {
    throw new McpError(ErrorCode.InvalidParams, `propertyType must be one of: ${Object.keys(ROOM_TYPES).join(", ")}`);
  }

  // Build search URL
  // Airbnb path segments use "--" as the separator (e.g. "Paris--France"),
  // not URL-encoded punctuation.  encodeURIComponent turns commas into %2C
  // which confuses Airbnb's geocoder (e.g. Paris → Barneville-Carteret).
  const slug = location
    .replace(/,\s*/g, "--")   // "Paris, France" → "Paris--France"
    .replace(/\s+/g, "-");    // remaining spaces → single dash
  const searchUrl = prepared ? new URL(prepared.url) : new URL(`${BASE_URL}/s/${encodeURIComponent(slug)}/homes`);

  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());

  if (!prepared) {
    // Add placeId
    if (placeId) searchUrl.searchParams.append("place_id", placeId);

    // Geocode and add bounding box to fix broken server-side geocoding.
    // Skipped when placeId is supplied (Airbnb's place lookup is reliable for those)
    // or when DISABLE_GEOCODING=true (user opt-out from third-party calls).
    if (!placeId && !DISABLE_GEOCODING) {
      const coords = await geocodeLocation(location);
      if (coords) {
        searchUrl.searchParams.append("ne_lat", coords.ne_lat);
        searchUrl.searchParams.append("ne_lng", coords.ne_lng);
        searchUrl.searchParams.append("sw_lat", coords.sw_lat);
        searchUrl.searchParams.append("sw_lng", coords.sw_lng);
      }
    }

    // Add query parameters
    if (checkin) searchUrl.searchParams.append("checkin", checkin);
    if (checkout) searchUrl.searchParams.append("checkout", checkout);
    if (dateFlexibilityDays > 0) searchUrl.searchParams.append("flexible_date_search_filter_type", FLEXIBLE_DATE_FILTERS[dateFlexibilityDays]);
    if (currency !== undefined) searchUrl.searchParams.append("currency", currency);

    // Add guests
    const totalGuests = adults_int + children_int;
    if (totalGuests > 0) {
      searchUrl.searchParams.append("adults", adults_int.toString());
      searchUrl.searchParams.append("children", children_int.toString());
      searchUrl.searchParams.append("infants", infants_int.toString());
      searchUrl.searchParams.append("pets", pets_int.toString());
    }

    // Add price range
    if (minPrice != null) searchUrl.searchParams.append("price_min", minPrice.toString());
    if (maxPrice != null) searchUrl.searchParams.append("price_max", maxPrice.toString());
    if (minPrice != null || maxPrice != null) searchUrl.searchParams.append("price_filter_input_type", "0");

    // Airbnb applies these minimums before pagination; 0 means no restriction.
    if (minBedrooms !== undefined) searchUrl.searchParams.append("min_bedrooms", minBedrooms.toString());
    if (minBeds !== undefined) searchUrl.searchParams.append("min_beds", minBeds.toString());
    if (minBathrooms !== undefined) searchUrl.searchParams.append("min_bathrooms", minBathrooms.toString());

    for (const amenity of new Set<string>(amenities ?? [])) {
      searchUrl.searchParams.append("amenities[]", AMENITY_IDS[amenity]);
    }

    // Keep the public parameter name, but send Airbnb's room-type filter.
    if (propertyType !== undefined) {
      searchUrl.searchParams.append("room_types[]", ROOM_TYPES[propertyType]);
    }

    // Add cursor for pagination
    if (cursor) {
      searchUrl.searchParams.append("cursor", cursor);
    }

  }

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt', { path, url: searchUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: searchUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing : {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true
      },
      mapSecondaryLine: {
        body: true
      },
      primaryLine: {
        body: true
      },
      secondaryLine: {
        body: true
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true
          }
        }
      }
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  try {
    log('info', 'Performing Airbnb search', { location, checkin, checkout, adults, children });
    
    const html = await fetchHtmlWithUserAgent(searchUrl.toString(), prepared?.timeoutMs);
    const $ = cheerio.load(html);
    
    let staysSearchResults: any = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
      let resolvedCurrency: string | null = null;
      try {
        resolvedCurrency = resolveCurrency(JSON.parse($("#data-injector-instances").text()));
      } catch {
        // Missing currency metadata must not turn an ambiguous symbol into USD.
      }
      const pricing = results.searchResults.map((result: any) => extractPricing(result, {
        currency: resolvedCurrency, requestedCurrency: currency, checkin, checkout
      }));
      cleanObject(results);
      
      const searchResults = results.searchResults
          .map((result: any) => flattenArraysInObject(pickBySchema(result, allowSearchResultSchema)))
          .map((result: any, index: number) => {
            const id = atob(result.demandStayListing.id).split(":")[1];
            const quote = pricing[index];
            const availability = describeAvailability(quote, { checkin, checkout, dateFlexibilityDays });
            const listingUrl = new URL(`${BASE_URL}/rooms/${id}`);
            if (quote.checkin && quote.checkout) {
              listingUrl.searchParams.set("check_in", quote.checkin);
              listingUrl.searchParams.set("check_out", quote.checkout);
            }
            for (const [name, count] of Object.entries({ adults: adults_int, children: children_int, infants: infants_int, pets: pets_int })) {
              listingUrl.searchParams.set(name, count.toString());
            }
            if (quote.currency) listingUrl.searchParams.set("currency", quote.currency);
            return {id, url: listingUrl.toString(), ...result, pricing: quote, availability }
          });
      staysSearchResults = {
        ...filterByAvailability(searchResults, checkin !== undefined && checkout !== undefined, params.discoverPartialStays === true || !!prepared),
        paginationInfo: results.paginationInfo,
        retrievedAt: new Date().toISOString()
      }
      
      log('info', 'Search completed successfully', { 
        resultCount: staysSearchResults.searchResults?.length || 0 
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const searchPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'staysSearch', 'results'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, searchPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse search results', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        url: searchUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            searchUrl: searchUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    if (params.discoverPartialStays) {
      staysSearchResults = await runPartialStayDiscovery(staysSearchResults, searchUrl, {
        checkin, checkout, dateFlexibilityDays,
        minPartialNights: params.minPartialNights, maxPartialSearches: params.maxPartialSearches,
      }, async (url, timeoutMs) => {
        const result = await handleAirbnbSearch({
          ...params, checkin: url.searchParams.get("checkin"), checkout: url.searchParams.get("checkout"),
          dateFlexibilityDays: 0, cursor: undefined,
          discoverPartialStays: false, minPartialNights: undefined, maxPartialSearches: undefined,
        }, { url, timeoutMs });
        const page = JSON.parse(result.content[0].text);
        if (result.isError) throw new Error(page.error ?? "Shorter-stay search failed");
        return page;
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          ...staysSearchResults
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Search request failed', {
      error: error instanceof Error ? error.message : String(error),
      url: searchUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          searchUrl: searchUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  let context: ReturnType<typeof normalizeListingInput>;
  try { context = normalizeListingInput(params); }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error)); }
  const { id, listingUrl, checkin, checkout } = context;
  const ignoreRobotsText = params.ignoreRobotsText ?? false;

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt', { path, url: listingUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: listingUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSectionSchema: Record<string, any> = {
    "LOCATION_DEFAULT": {
      lat: true,
      lng: true,
      subtitle: true,
      title: true
    },
    "POLICIES_DEFAULT": {
      title: true,
      houseRulesSections: {
        title: true,
        items : {
          title: true
        }
      }
    },
    "HIGHLIGHTS_DEFAULT": {
      highlights: {
        title: true
      }
    },
    "DESCRIPTION_DEFAULT": {
      htmlDescription: {
        htmlText: true
      }
    },
    "AMENITIES_DEFAULT": {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true
        }
      }
    },
    //"AVAILABLITY_CALENDAR_DEFAULT": true,
  };

  try {
    log('info', 'Fetching listing details', { id, checkin, checkout });
    
    const html = await fetchHtmlWithUserAgent(listingUrl.toString());
    const $ = cheerio.load(html);
    
    // Always an array. A consumer doing details.find(...) should never meet an object.
    let details: any[] = [];
    let listing: ReturnType<typeof extractListing> | undefined;
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const sections = listingSections(clientData);
      if (!sections.length && !findPdpPresentation(clientData)) throw new Error("No listing details found in page data");
      listing = extractListing(clientData, html, context);
      sections.forEach((section: any) => cleanObject(section));
      
      let extracted: any[] = sections
        .filter((section: any) => allowSectionSchema.hasOwnProperty(section.sectionId))
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(keyAmenityGroups(pickBySchema(section.section, allowSectionSchema[section.sectionId])))
          }
        });

      // Fill in the sections Airbnb now renders client-side.
      //
      // Substitute only when the content key this section exists to carry is actually
      // absent. Counting keys would be fragile in the direction that loses data: if
      // Airbnb ever adds one placeholder key to a stub, a count-based test would decide
      // the section was populated and silently discard the recovered content.
      const pdp = findPdpPresentation(clientData);
      const recovered: string[] = [];
      if (pdp) {
        const fromPdp: Record<string, { value: any | null; contentKey: string }> = {
          AMENITIES_DEFAULT: { value: extractAmenities(pdp), contentKey: "seeAllAmenitiesGroups" },
          HIGHLIGHTS_DEFAULT: { value: extractHighlights(pdp), contentKey: "highlights" },
        };

        extracted = extracted.map((section: any) => {
          const replacement = fromPdp[section.id];
          if (replacement?.value && !section[replacement.contentKey]) {
            recovered.push(section.id);
            // Merge onto the section rather than replacing it. A stub can be partial —
            // carrying a title while missing the content — and rebuilding from `id`
            // alone would throw away whatever the section tree did manage to supply.
            return { ...section, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) };
          }
          return section;
        });

        // Also cover the case where the stub is dropped from the section list entirely.
        for (const [sectionId, replacement] of Object.entries(fromPdp)) {
          if (replacement.value && !extracted.some((s: any) => s.id === sectionId)) {
            recovered.push(sectionId);
            extracted.push({ id: sectionId, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) });
          }
        }
      }

      details = extracted;

      log('info', 'Listing details fetched successfully', {
        id,
        sectionsFound: extracted.length,
        recoveredFromPdpPresentation: recovered.length ? recovered : undefined
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const detailsPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'stayProductDetailPage', 'sections', 'sections'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, detailsPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse listing details', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        id,
        url: listingUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            listingUrl: listingUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    if (listing && checkin && checkout) {
      const datedBooking = await fetchDatedBooking(html, context, path => ignoreRobotsText || isPathAllowed(path));
      listing = { ...listing, booking: { ...listing.booking, ...datedBooking } };
      listing.coverage.note = "Public listing details plus a dated booking lookup. Check booking.quoteStatus and datesVerified before quoting availability. Full review history, calendar and cancellation terms are not included.";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          listingId: id,
          retrievedAt: new Date().toISOString(),
          listing,
          details: details
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Listing details request failed', {
      error: error instanceof Error ? error.message : String(error),
      id,
      url: listingUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          listingUrl: listingUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Enhanced logging for DXT
function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  disableGeocoding: DISABLE_GEOCODING,
  nodeVersion: process.version,
  platform: process.platform
});

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  
  try {
    // Validate request parameters
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    
    if (!request.params.arguments && request.params.name !== "airbnb_list_amenities") {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }
    
    log('info', 'Tool call received', { 
      tool: request.params.name,
      arguments: request.params.arguments 
    });
    
    // Ensure robots.txt is loaded
    if (request.params.name !== "airbnb_list_amenities" && !robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "airbnb_list_amenities": {
        if (Object.keys(request.params.arguments ?? {}).length > 0) {
          throw new McpError(ErrorCode.InvalidParams, "airbnb_list_amenities takes no arguments");
        }
        result = {
          content: [{
            type: "text",
            text: JSON.stringify({
              amenities: Object.entries(AMENITIES).map(([name, { label, description }]) => ({ name, label, description })),
              usage: "Pass amenity names in airbnb_search's amenities array. All selected amenities are requested together. Use airbnb_listing_details to check a property's amenities and access conditions."
            }, null, 2)
          }],
          isError: false
        };
        break;
      }

      case "airbnb_search": {
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
    
    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', { 
      tool: request.params.name, 
      duration: `${duration}ms`,
      success: !result.isError 
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
});

async function runServer() {
  try {
    // Load robots.txt when a network-backed tool is called, so discovery works offline.
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT
    });
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
    
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
