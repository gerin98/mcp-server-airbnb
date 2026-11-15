import { dateNights } from "./pricing.js";

// Verified against Airbnb's MicroFlexItem search controls on 2026-11-15.
// Airbnb's code 0 means ±1 day; exact dates require omitting the parameter.
export const FLEXIBLE_DATE_FILTERS: Record<number, string> = {
  1: "0",
  2: "3",
  3: "1",
  7: "2",
  14: "6",
};

export function describeAvailability(
  matched: { checkin: string | null; checkout: string | null; datesMatchPrice?: boolean | null },
  requested: { checkin?: string; checkout?: string; dateFlexibilityDays?: number }
) {
  const requestedNights = dateNights(requested.checkin, requested.checkout);
  const matchedNights = dateNights(matched.checkin, matched.checkout);
  const canCompare = requestedNights !== null && matchedNights !== null;
  const dayOffset = (actual: string, original: string) =>
    (Date.parse(`${actual}T00:00:00Z`) - Date.parse(`${original}T00:00:00Z`)) / 86400000;
  const checkinOffsetDays = canCompare ? dayOffset(matched.checkin!, requested.checkin!) : null;
  const checkoutOffsetDays = canCompare ? dayOffset(matched.checkout!, requested.checkout!) : null;
  const flexibility = requested.dateFlexibilityDays ?? 0;
  const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const coveredRequestedNights = canCompare ? Math.max(0,
    (Math.min(timestamp(matched.checkout!), timestamp(requested.checkout!)) -
      Math.max(timestamp(matched.checkin!), timestamp(requested.checkin!))) / 86400000
  ) : null;
  const matchesRequestedDates = canCompare ? checkinOffsetDays === 0 && checkoutOffsetDays === 0 : null;
  const matchType = matched.datesMatchPrice === false || matchedNights === null ? "unknown"
    : requestedNights === null ? "suggested_dates"
    : matchesRequestedDates ? "exact_dates"
    : coveredRequestedNights! > 0 && coveredRequestedNights! < requestedNights ? "partial_stay"
    : "alternative_dates";
  const quotedStay = `${matched.checkin} to ${matched.checkout} (${matchedNights} ${matchedNights === 1 ? "night" : "nights"})`;
  const label = matchType === "exact_dates" ? `Full requested stay: ${quotedStay}`
    : matchType === "partial_stay" ? `Partial stay: ${coveredRequestedNights} of ${requestedNights} requested nights; quoted stay ${quotedStay}`
    : matchType === "alternative_dates" ? `Alternative dates: ${quotedStay}`
    : matchType === "suggested_dates" ? `Suggested dates: ${quotedStay}`
    : matched.datesMatchPrice === false ? "Unclear availability: quoted night count does not match the dates"
    : "Availability dates unknown";
  return {
    source: "airbnb_search",
    matchType,
    label,
    requestedCheckin: requested.checkin ?? null,
    requestedCheckout: requested.checkout ?? null,
    dateFlexibilityDays: flexibility,
    matchedCheckin: matched.checkin,
    matchedCheckout: matched.checkout,
    requestedNights,
    matchedNights,
    coveredRequestedNights,
    missingRequestedNights: canCompare ? requestedNights! - coveredRequestedNights! : null,
    matchesRequestedDates,
    withinRequestedWindow: canCompare ? Math.abs(checkinOffsetDays!) <= flexibility && Math.abs(checkoutOffsetDays!) <= flexibility : null,
    checkinOffsetDays,
    checkoutOffsetDays,
    matchesRequestedStayLength: canCompare ? matchedNights === requestedNights : null,
  };
}

export function filterByAvailability<T extends {
  availability: ReturnType<typeof describeAvailability>;
  pricing: { datesMatchPrice: boolean | null };
}>(results: T[], hasRequestedDates: boolean) {
  const searchResults = hasRequestedDates
    ? results.filter(result =>
      (result.availability.withinRequestedWindow === true || result.availability.matchType === "partial_stay") &&
      result.pricing.datesMatchPrice !== false)
    : results;
  return {
    searchResults,
    availabilityFilter: {
      applied: hasRequestedDates,
      excludedResults: results.length - searchResults.length,
      partialStayResults: searchResults.filter(result => result.availability.matchType === "partial_stay").length,
    },
  };
}
