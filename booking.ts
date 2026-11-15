import * as cheerio from "cheerio";
import fetch from "node-fetch";
import { dateNights, extractPricing, resolveCurrency } from "./pricing.js";
import { normalizeListingInput, publicContent } from "./listing.js";

type ListingContext = ReturnType<typeof normalizeListingInput>;
const OPERATION = "StaysPdpBookItQuery";
const API_PATH = `/api/v3/${OPERATION}`;
const USER_AGENT = "Mozilla/5.0";

export function quotePageMetadata(html: string) {
  const $ = cheerio.load(html);
  let injector: any = {};
  try { injector = JSON.parse($("#data-injector-instances").text()); } catch { /* unsupported page */ }
  let apiKey: string | null = null;
  for (const entries of Object.values(injector ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.[0] === "BootstrapDataToken") {
        const key = entry?.[1]?.["layout-init"]?.api_config?.key;
        if (typeof key === "string" && key) apiKey = key;
      }
    }
  }
  const assetUrl = $("script[src]").toArray().map(script => $(script).attr("src")!)
    .find(src => {
      try {
        const url = new URL(src);
        return url.origin === "https://a0.muscache.com" && !url.username && !url.password &&
          /^\/airbnb\/static\/packages\/web\/.+\/PdpPlatformRoute\.[a-zA-Z0-9]+\.js$/.test(url.pathname);
      } catch { return false; }
    }) ?? null;
  return { apiKey, assetUrl, currency: resolveCurrency(injector) };
}

// Discover the operation from the page's own versioned bundle instead of pinning
// a persisted-query hash that will silently become stale after an Airbnb deploy.
export function quoteOperationHash(script: string): string {
  const match = script.match(/name\s*:\s*["']StaysPdpBookItQuery["']\s*,\s*type\s*:\s*["']query["']\s*,\s*operationId\s*:\s*["']([a-f0-9]{64})["']/);
  if (!match) throw new Error("Airbnb's dated quote operation was not found in its page assets");
  return match[1];
}

export function quoteRequest(context: ListingContext, currency: string, hash: string) {
  if (dateNights(context.checkin, context.checkout) === null) throw new Error("Dated quotes require a valid checkin and checkout");
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid quote request metadata");
  const dateRange = { startDate: context.checkin, endDate: context.checkout };
  const variables = {
    id: Buffer.from(`DemandStayListing:${context.id}`).toString("base64"),
    dateRange,
    guestCounts: {
      numberOfAdults: context.adults, numberOfChildren: context.children,
      numberOfInfants: context.infants, numberOfPets: context.pets,
    },
    includePdpMigrationBookItCalendarSheetFragment: true,
    includePdpMigrationBookItFloatingFooterFragment: true,
    includePdpMigrationBookItNavFragment: true,
    includePdpMigrationBookItSidebarFragment: true,
    includeGalleryBookItCtaFragment: true,
    includeOverviewMerchandisingTipsFragment: true,
    includeStaysPdpPriceHeatmapFragment: false,
    priceHeatmapDateRange: dateRange,
    p3ImpressionId: null, selectedCancellationPolicyId: null, causeId: null,
    selectedGuestOptionId: null, federatedSearchId: null, interactionType: null,
    logEntityPricingViewEvent: false,
  };
  const url = new URL(`https://www.airbnb.com${API_PATH}/${hash}`);
  url.searchParams.set("operationName", OPERATION);
  url.searchParams.set("locale", "en");
  url.searchParams.set("currency", currency);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  return url;
}

// The headline may be rounded while productItemDetail contains the exact total.
// Merge those breakdowns without counting the same nightly subtotal twice.
function quotePrice(book: any) {
  const seen = new Set<string>();
  const priceDetails: any[] = [];
  for (const explanation of [book.structuredDisplayPrice?.explanationData, book.productItemDetail?.explanationData]) {
    for (const group of explanation?.priceDetails ?? []) {
      if (Array.isArray(group.items)) {
        const items = group.items.filter((item: any) => {
          const key = JSON.stringify([item.description, item.priceString]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (items.length) priceDetails.push({ ...group, items });
      } else if (typeof group.content === "string" && !seen.has(group.content)) {
        seen.add(group.content);
        priceDetails.push(group);
      }
    }
  }
  const announcement = publicContent(book.announcement?.title);
  if (typeof announcement === "string" && announcement) priceDetails.push({ content: announcement });
  return { ...book.structuredDisplayPrice, explanationData: { ...book.structuredDisplayPrice?.explanationData, priceDetails } };
}

// The endpoint echoes a localized date label rather than ISO dates. Requests use
// English; recognize its compact forms and reject a stale/different date range.
function matchesDateLabel(label: unknown, checkin: string, checkout: string): boolean {
  if (typeof label !== "string") return false;
  const start = new Date(`${checkin}T00:00:00Z`);
  const end = new Date(`${checkout}T00:00:00Z`);
  const month = (date: Date) => date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const first = `${month(start)} ${start.getUTCDate()}`;
  const last = `${month(end)} ${end.getUTCDate()}`;
  const normalize = (text: string) => text.replace(/[,\s]/g, "").replace(/[–—]/g, "-").toLowerCase();
  const forms = [
    `${first}-${last}`,
    `${first}-${last}, ${end.getUTCFullYear()}`,
    `${first}, ${start.getUTCFullYear()}-${last}, ${end.getUTCFullYear()}`,
  ];
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
    forms.push(`${first}-${end.getUTCDate()}`, `${first}-${end.getUTCDate()}, ${end.getUTCFullYear()}`);
  }
  return forms.some(form => normalize(form) === normalize(label));
}

export function parseDatedQuote(response: any, context: ListingContext, currency: string) {
  if (dateNights(context.checkin, context.checkout) === null) throw new Error("Dated quotes require a valid checkin and checkout");
  if (Array.isArray(response?.errors) && response.errors.length) throw new Error("Airbnb returned errors for the dated quote");
  const node = response?.data?.node;
  if (node?.id && node.id !== Buffer.from(`DemandStayListing:${context.id}`).toString("base64")) {
    throw new Error("Airbnb returned a quote for a different listing");
  }
  const book = node?.pdpPresentation?.bookIt;
  if (book?.__typename !== "StandardBookIt" || typeof book.availability?.isAvailable !== "boolean") {
    throw new Error("Airbnb did not return a supported dated availability response");
  }
  if (!matchesDateLabel(book.selectedDates, context.checkin, context.checkout)) {
    throw new Error("Airbnb's quoted date label does not match the requested dates");
  }
  const available = book.availability.isAvailable;
  const hasPrice = !!(book.structuredDisplayPrice?.primaryLine || book.structuredDisplayPrice?.secondaryLine);
  const parsed = hasPrice ? extractPricing({ structuredDisplayPrice: quotePrice(book) }, {
    currency, requestedCurrency: context.currency, checkin: context.checkin, checkout: context.checkout
  }) : null;
  if (parsed?.datesMatchPrice === false) throw new Error("Airbnb's quoted night count does not match the requested dates");
  const pricing = available && parsed ? {
    ...parsed,
    // A 'nights x rate' line in this response can already include every fee.
    // Preserve the quoted rate without asserting it is the underlying rent.
    baseNightlyRate: null,
    quotedNightlyRate: parsed.baseNightlyRate ?? parsed.displayedNightlyRate,
    currencySource: "quote_request",
    feesIncluded: book.announcement?.type === "PRICE_TRANSPARENCY_FEE_INCLUSIVE" ? true : parsed.feesIncluded,
    feesItemized: parsed.fees.length > 0,
    taxesItemized: parsed.taxes.length > 0,
  } : null;
  const kicker = publicContent(book.availabilityDetailsKicker);
  const cancellationSummary = typeof kicker === "string" && /cancel|refund/i.test(kicker) ? kicker : null;
  return {
    source: "airbnb_dated_quote",
    quoteStatus: "checked" as const,
    checkedAt: new Date().toISOString(),
    requestedCheckin: context.checkin, requestedCheckout: context.checkout,
    guests: { adults: context.adults, children: context.children, infants: context.infants, pets: context.pets },
    currency, requestedCurrency: context.currency ?? null, currencySource: "quote_request",
    availabilityStatus: available ? "available" : "unavailable",
    available, datesVerified: true,
    verificationSource: "dated_quote_request",
    selectedDatesLink: null,
    selectedDatesLabel: typeof book.selectedDates === "string" ? book.selectedDates : null,
    selectedNights: dateNights(context.checkin, context.checkout),
    message: publicContent(book.availability.unavailabilityMessage) ?? null,
    unavailabilityReason: book.availability.unavailabilityReason ?? null,
    pricingStatus: pricing ? "quoted" : "not_provided",
    pricing,
    cancellationPolicy: cancellationSummary ? { summary: cancellationSummary, fullTermsAvailable: false } : null,
    canInstantBook: typeof book.availability.canInstantBook === "boolean" ? book.availability.canInstantBook : null,
    notes: [
      "Availability applies to this listing, date range and guest counts at the time checked; it is not a reservation.",
      "Currency is the explicit quote-request currency; the response does not independently echo its ISO code.",
      "Only the returned cancellation summary is included; full refund terms and deadlines must be confirmed on Airbnb.",
    ],
  };
}

type TextFetcher = (url: string, headers?: Record<string, string>) => Promise<string>;
async function fetchQuoteText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...headers },
      signal: controller.signal, redirect: "error", size: 5 * 1024 * 1024,
    });
    if (!response.ok) throw new Error(`Airbnb quote request failed (HTTP ${response.status})`);
    return await response.text();
  } finally { clearTimeout(timeout); }
}

// Only cache the operation ID from immutable versioned assets, never live quotes.
const operationCache = new Map<string, string>();
export async function fetchDatedBooking(
  html: string,
  context: ListingContext,
  isAllowed: (path: string) => boolean,
  fetchText: TextFetcher = fetchQuoteText,
) {
  const failure = (quoteStatus: "error" | "blocked", message: string) => ({
    source: "airbnb_dated_quote", quoteStatus, checkedAt: new Date().toISOString(),
    available: null, availabilityStatus: "unknown", datesVerified: false,
    pricing: null, pricingStatus: "not_provided", cancellationPolicy: null,
    canInstantBook: null, message,
  });
  try {
    if (!isAllowed(API_PATH)) return failure("blocked", "Dated quote lookup is blocked by robots.txt");
    const { apiKey, assetUrl, currency: pageCurrency } = quotePageMetadata(html);
    const currency = context.currency ?? pageCurrency;
    if (!apiKey || !assetUrl || !currency) throw new Error("The public page is missing the metadata needed for a dated quote");
    let hash = operationCache.get(assetUrl);
    if (!hash) {
      hash = quoteOperationHash(await fetchText(assetUrl));
      if (operationCache.size >= 4) operationCache.clear();
      operationCache.set(assetUrl, hash);
    }
    const url = quoteRequest(context, currency, hash);
    if (!isAllowed(url.pathname + url.search)) return failure("blocked", "Dated quote lookup is blocked by robots.txt");
    const text = await fetchText(url.toString(), { "X-Airbnb-API-Key": apiKey, Referer: context.listingUrl.toString() });
    return parseDatedQuote(JSON.parse(text), context, currency);
  } catch (error) {
    // Do not discard useful static listing details when this extra request fails.
    // Do not leak provider payloads, API keys or request URLs into the response.
    const message = error instanceof Error && /^(Airbnb|The public page|Dated quotes)/.test(error.message)
      ? error.message : "Could not retrieve Airbnb's dated quote; price and availability remain unknown";
    return failure("error", message);
  }
}
