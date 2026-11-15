import * as cheerio from "cheerio";
import { dateNights, extractPricing, resolveCurrency } from "./pricing.js";
import { findPdpPresentation, pickBySchema } from "./util.js";

// Only extract an ID from a recognized Airbnb host. Fetches always use airbnb.com.
const AIRBNB_DOMAINS = new Set("com ca co.uk com.au co.nz co.in ie fr de es it pt nl be at ch dk no se fi is pl cz hu gr com.br mx cl com.ar co.cr com.co co.ve com.pe co.kr jp cn com.hk com.tw com.sg com.my co.id com.ph co.th co.za ae ru com.tr".split(" ").map(s => `airbnb.${s}`));

export function normalizeListingInput(params: Record<string, any>) {
  let inputUrl: URL | undefined;
  let urlId: string | undefined;
  if (params.url !== undefined) {
    if (typeof params.url !== "string") throw new Error("url must be an Airbnb listing URL");
    try { inputUrl = new URL(params.url); } catch { throw new Error("url must be a complete Airbnb listing URL"); }
    const host = inputUrl.hostname.replace(/^(www|www\d|m)\./, "");
    if (!["http:", "https:"].includes(inputUrl.protocol) || !AIRBNB_DOMAINS.has(host) || inputUrl.username || inputUrl.password || inputUrl.port) {
      throw new Error("url must use a recognized Airbnb website");
    }
    urlId = inputUrl.pathname.match(/^\/rooms\/(?:plus\/)?([1-9]\d*)\/?$/)?.[1];
    if (!urlId) throw new Error("Use the full Airbnb listing URL containing /rooms/ID; shortened share links are not supported");
  }
  if (params.id !== undefined && (typeof params.id !== "string" || !/^[1-9]\d*$/.test(params.id))) {
    throw new Error("id must be a numeric Airbnb listing ID supplied as a string");
  }
  if (params.id && urlId && params.id !== urlId) throw new Error("id and url refer to different Airbnb listings");
  const id = params.id ?? urlId;
  if (!id) throw new Error("Provide an Airbnb listing url or id");
  const value = (key: string, query = key) => params[key] !== undefined ? params[key] : inputUrl?.searchParams.get(query) ?? undefined;
  const checkin = value("checkin", "check_in");
  const checkout = value("checkout", "check_out");
  if ((checkin !== undefined || checkout !== undefined) && dateNights(checkin, checkout) === null) {
    throw new Error("checkin and checkout must be valid YYYY-MM-DD dates with checkout after checkin");
  }
  const currency = value("currency");
  if (currency !== undefined && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error("currency must be a three-letter uppercase currency code");
  }
  const guests: Record<string, number> = {};
  for (const key of ["adults", "children", "infants", "pets"]) {
    const raw = value(key);
    const count = raw === undefined ? (key === "adults" ? 1 : 0) : params[key] !== undefined ? raw : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(count) || count < (key === "adults" ? 1 : 0)) throw new Error(`${key} must be a whole number ${key === "adults" ? "at least 1" : "at least 0"}`);
    guests[key] = count;
  }
  const listingUrl = new URL(`https://www.airbnb.com/rooms/${id}`);
  if (checkin) listingUrl.searchParams.set("check_in", checkin);
  if (checkout) listingUrl.searchParams.set("check_out", checkout);
  if (currency) listingUrl.searchParams.set("currency", currency);
  for (const [key, count] of Object.entries(guests)) listingUrl.searchParams.set(key, String(count));
  return { id, listingUrl, checkin, checkout, currency,
    adults: guests.adults, children: guests.children, infants: guests.infants, pets: guests.pets };
}

export function listingSections(clientData: any): any[] {
  for (const entry of clientData?.niobeClientData ?? []) {
    const sections = entry?.[1]?.data?.presentation?.stayProductDetailPage?.sections?.sections;
    if (Array.isArray(sections)) return sections;
  }
  return [];
}

// Convert Airbnb's localized text wrappers and HTML to readable text, retaining
// arrays and booleans (especially unavailable amenities) in the structured output.
export function publicContent(value: any): any {
  if (typeof value === "string") {
    const $ = cheerio.load(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n"));
    $("script, style").remove();
    return $.root().text().trim();
  }
  if (Array.isArray(value)) return value.map(publicContent);
  if (!value || typeof value !== "object") return value;
  if (value.localizedStringWithTranslationPreference !== undefined || value.localizedString !== undefined) {
    return publicContent(value.localizedStringWithTranslationPreference ?? value.localizedString);
  }
  if (value.__typename === "PdpUGCText") return publicContent(value.content);
  if (value.__typename === "LocalizedText") return publicContent(value.text);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, v]) => v !== null && !/^(?:__typename|icon|iconIdentifier|id|imageId|assetMetadata|enrichmentData|accessibilityLabel|a11yValue)$|logging|tracking|debug/i.test(key))
    .map(([key, v]) => [key, publicContent(v)]));
}

const select = (value: any, schema: Record<string, any>) => value ? publicContent(pickBySchema(value, schema)) : null;

export function extractListing(clientData: any, html: string, context: ReturnType<typeof normalizeListingInput>) {
  const pdp = findPdpPresentation(clientData);
  const listingNode = (clientData?.niobeClientData ?? []).map((entry: any) => entry?.[1]?.data?.node)
    .find((node: any) => node?.pdpPresentation && node.pdpPresentation === pdp);
  const sections = listingSections(clientData);
  const section = (id: string) => sections.find(s => s.sectionId === id)?.section;
  const $ = cheerio.load(html);
  let currency: string | null = null;
  try { currency = resolveCurrency(JSON.parse($("#data-injector-instances").text())); } catch { /* not always embedded */ }
  const title = publicContent(pdp?.title) || section("TITLE_DEFAULT")?.title || $("meta[property='og:title']").attr("content") || null;
  const description = publicContent(pdp?.descriptions?.longDescriptionHtml ?? pdp?.descriptions?.shortDescriptionHtml ?? section("DESCRIPTION_DEFAULT")?.htmlDescription?.htmlText) ?? null;
  const amenityGroups = pdp?.amenities?.seeAllAmenitiesGroups ?? section("AMENITIES_DEFAULT")?.seeAllAmenitiesGroups;
  const amenities = Array.isArray(amenityGroups) ? amenityGroups.map((g: any) => ({
    title: g.title,
    amenities: (g.amenities ?? []).map((a: any) => ({ title: a.title, subtitle: publicContent(a.subtitle) ?? null, available: typeof a.available === "boolean" ? a.available : null }))
  })) : null;
  const photos = new Map<string, any>();
  const collectPhotos = (value: any) => {
    if (!value || typeof value !== "object") return;
    const uri = value.uri ?? value.baseUrl;
    if (typeof uri === "string" && /^https:\/\//.test(uri)) photos.set(uri, {
      url: uri, caption: publicContent(value.caption) ?? null, altText: publicContent(value.altText ?? value.accessibilityLabel) ?? null
    });
    for (const child of Object.values(value)) if (child && typeof child === "object") collectPhotos(child);
  };
  collectPhotos(pdp?.mediaTour);
  collectPhotos(pdp?.heroMedia);
  collectPhotos(section("PHOTO_TOUR_SCROLLABLE_MODAL")?.mediaItems);
  const book = section("BOOK_IT_SIDEBAR") ?? section("BOOK_IT_FLOATING_FOOTER");
  const price = book?.structuredDisplayPrice;
  const hasPrice = !!(price?.primaryLine || price?.secondaryLine);
  const availability = typeof book?.available === "boolean" ? book.available : null;
  const listing = {
    title, description,
    overview: select(pdp?.overview ?? section("OVERVIEW_DEFAULT_V2"), { title: true, items: true, detailItems: true }),
    personCapacity: pdp?.personCapacity ?? book?.maxGuestCapacity ?? null,
    propertyType: pdp?.sharingConfig?.propertyType ?? null,
    buildingType: typeof listingNode?.propertyType === "string" ? listingNode.propertyType.toLowerCase() : null,
    highlights: select(pdp, { highlights: { title: true, subtitle: true } })?.highlights ?? null,
    amenities,
    sleepingArrangements: select(pdp?.sleepingArrangements, { name: true, stops: { name: true, description: true } }),
    location: select(pdp?.location ?? section("LOCATION_DEFAULT"), {
      subtitle: true, title: true, latitude: true, longitude: true, lat: true, lng: true, isExactLocation: true,
      locationName: true, locationSummary: true, exactAddress: true, previewLocationDetails: true, seeAllLocationDetails: true,
      verificationDetails: { verifiedHelpHtml: true }
    }),
    host: select(pdp?.hostInfo, {
      passportData: { name: true, titleText: true, profilePictureUrl: true, isSuperhost: true, isVerified: true, stats: true },
      about: true, highlights: { text: true }, responseRateText: true, responseTimeText: true
    }),
    ratings: select(pdp?.quality, { listingRatingStats: true, isGuestFavorite: true, isNewListing: true, categoryRatings: true, ratingDistribution: true }),
    houseRules: select(pdp?.rules ?? section("POLICIES_DEFAULT"), { title: true, description: true, groupItems: true, houseRulesSections: true }),
    safetyAndProperty: select(pdp?.safetyAndProperty, { title: true, description: true, groupItems: true }),
    accessibility: select(pdp?.accessibilityFeatures, { name: true, stops: true }),
    guestRequirements: select(pdp?.pdpGuestPickerConfig, { guestMaxCount: true, childrenAllowed: true, infantsAllowed: true, childrenAndInfantsWarning: true }),
    photos: [...photos.values()],
    booking: {
      source: "public_listing_page",
      quoteStatus: "not_requested",
      requestedCheckin: context.checkin ?? null, requestedCheckout: context.checkout ?? null,
      currency, requestedCurrency: context.currency ?? null,
      availabilityStatus: availability === null ? "unknown" : availability ? "available" : "unavailable",
      available: availability,
      // URL dates alone do not prove the page has priced or checked those dates.
      datesVerified: false,
      selectedDatesLink: book?.selectedDatesLink ?? null,
      selectedNights: book?.selectedNights ?? null,
      message: publicContent(book?.localizedUnavailabilityMessage ?? book?.calendarSubtitle) ?? null,
      pricingStatus: hasPrice ? "present_on_page" : "not_provided",
      pricing: hasPrice ? extractPricing(book, { currency, requestedCurrency: context.currency }) : null,
      cancellationPolicy: publicContent(book?.cancellationPolicyForDisplay ?? book?.cancellationPolicies) ?? null,
      canInstantBook: book?.canInstantBook ?? null
    }
  };
  // Empty stubs should not masquerade as successfully recovered content.
  const missingFields = Object.entries(listing).filter(([, v]) => v === null || (typeof v === "object" && Object.keys(v).length === 0)).map(([k]) => k);
  return { ...listing, coverage: {
    source: "public_listing_page", missingFields,
    fullReviewHistoryIncluded: false, fullAvailabilityCalendarIncluded: false,
    note: "Only information embedded in the public page is returned. Missing price or availability is unknown, not free or unavailable. Requested dates alone do not verify a stay."
  } };
}
