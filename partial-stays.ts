import { describeAvailability } from "./availability.js";
import { dateNights } from "./pricing.js";
import { combineRatingReports, RatingFilterReport } from "./ratings.js";

export const DEFAULT_PARTIAL_SEARCHES = 6;
export const MAX_PARTIAL_SEARCHES = 8;
export const MAX_PARTIAL_RESULTS = 30;
const DISCOVERY_BUDGET_MS = 20000;
const WINDOW_TIMEOUT_MS = 8000;

export function validatePartialOptions(params: Record<string, any>) {
  const enabled = params.discoverPartialStays ?? false;
  if (params.discoverPartialStays !== undefined && typeof params.discoverPartialStays !== "boolean") {
    throw new Error("discoverPartialStays must be a boolean");
  }
  for (const [name, max] of [["minPartialNights", Number.MAX_SAFE_INTEGER], ["maxPartialSearches", MAX_PARTIAL_SEARCHES]] as const) {
    const value = params[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max)) {
      throw new Error(`${name} must be a whole number from 1 to ${max}`);
    }
    if (value !== undefined && !enabled) throw new Error(`${name} requires discoverPartialStays: true`);
  }
  if (enabled) {
    if (dateNights(params.checkin, params.checkout) === null) throw new Error("discoverPartialStays requires valid checkin and checkout dates");
    if (params.cursor !== undefined) throw new Error("discoverPartialStays cannot be combined with cursor; paginate each search separately with discovery disabled");
  }
}

export function planPartialStays(checkin: string, checkout: string, minNights = 2, maxSearches = DEFAULT_PARTIAL_SEARCHES) {
  validatePartialOptions({ discoverPartialStays: true, checkin, checkout, minPartialNights: minNights, maxPartialSearches: maxSearches });
  const requestedNights = dateNights(checkin, checkout)!;
  const trimLimit = Math.max(0, requestedNights - minNights);
  const candidateWindows = trimLimit * (trimLimit + 3) / 2;
  const day = (offset: number) => new Date(Date.parse(`${checkin}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const windows: { checkin: string; checkout: string; nights: number }[] = [];
  // Longest first, alternating earlier/later starts at each length, then middle
  // windows. Generate only the bounded plan, even for a years-long date range.
  for (let trimmed = 1; trimmed <= trimLimit && windows.length < maxSearches; trimmed++) {
    for (let i = 0; i <= trimmed && windows.length < maxSearches; i++) {
      const left = i % 2 === 0 ? i / 2 : trimmed - Math.floor(i / 2);
      windows.push({ checkin: day(left), checkout: day(requestedNights - trimmed + left), nights: requestedNights - trimmed });
    }
  }
  return { requestedNights, candidateWindows, windows };
}

export function partialSearchUrl(primary: URL, window: { checkin: string; checkout: string }) {
  const url = new URL(primary);
  url.searchParams.set("checkin", window.checkin);
  url.searchParams.set("checkout", window.checkout);
  url.searchParams.delete("cursor");
  url.searchParams.delete("flexible_date_search_filter_type");
  return url;
}

type SearchPage = { searchResults: any[]; paginationInfo?: any; availabilityFilter?: any; retrievedAt?: string; ratingFilter?: RatingFilterReport };
type SearchWindow = (url: URL, timeoutMs: number) => Promise<SearchPage>;

export async function discoverPartialStays(
  primary: SearchPage,
  primaryUrl: URL,
  options: { checkin: string; checkout: string; minPartialNights?: number; maxPartialSearches?: number; dateFlexibilityDays?: number },
  search: SearchWindow,
  now: () => number = Date.now,
) {
  const minNights = options.minPartialNights ?? 2;
  const maxSearches = options.maxPartialSearches ?? DEFAULT_PARTIAL_SEARCHES;
  const plan = planPartialStays(options.checkin, options.checkout, minNights, maxSearches);
  const deadline = now() + DISCOVERY_BUDGET_MS;
  const outcomes: { page?: SearchPage; report: any }[] = new Array(plan.windows.length);
  let next = 0;
  async function worker() {
    while (next < plan.windows.length) {
      const index = next++;
      const window = plan.windows[index];
      const url = partialSearchUrl(primaryUrl, window);
      const report = { ...window, searchUrl: url.toString() };
      const remaining = deadline - now();
      if (remaining <= 0) {
        outcomes[index] = { report: { ...report, status: "skipped", error: "Discovery time budget exhausted" } };
        continue;
      }
      try {
        const page = await search(url, Math.min(remaining, WINDOW_TIMEOUT_MS));
        if (!Array.isArray(page.searchResults)) throw new Error("Search returned no result array");
        outcomes[index] = { page, report: { ...report, status: "completed", paginationInfo: page.paginationInfo ?? null, retrievedAt: page.retrievedAt ?? null, ratingFilter: page.ratingFilter } };
      } catch (error) {
        outcomes[index] = { report: { ...report, status: "failed", error: error instanceof Error ? error.message : "Search failed" } };
      }
    }
  }
  await Promise.all([worker(), worker()]);

  const searchResults: any[] = [];
  const seen = new Set<string>();
  const add = (row: any) => {
    // Different stays at the same property remain distinct options. All searches
    // reuse the original guest/filter context; currency still participates in identity.
    const key = JSON.stringify([row.id, row.pricing?.checkin, row.pricing?.checkout, row.pricing?.currency]);
    if (seen.has(key)) return false;
    seen.add(key);
    searchResults.push(row);
    return true;
  };
  primary.searchResults.forEach(add);
  const fullStays = new Set(primary.searchResults.filter(row =>
    row.availability?.matchType === "exact_dates" && row.pricing?.datesMatchPrice === true
  ).map(row => JSON.stringify([row.id, row.pricing.currency])));
  let addedResults = 0;
  let omittedResults = 0;
  let suppressedFullStayResults = 0;
  for (const outcome of outcomes) {
    if (!outcome.page) continue;
    let eligibleResults = 0;
    let added = 0;
    let omitted = 0;
    let suppressed = 0;
    for (const row of outcome.page.searchResults) {
      const price = row.pricing;
      const nights = dateNights(price?.checkin, price?.checkout);
      // Airbnb may suggest dates outside the requested sub-window. Accept only
      // quoted, shorter stays wholly inside the user's original date range.
      if (!row.id || nights === null || nights < minNights || nights >= plan.requestedNights ||
          price.checkin < options.checkin || price.checkout > options.checkout || price.datesMatchPrice !== true) continue;
      eligibleResults++;
      if (fullStays.has(JSON.stringify([row.id, price.currency]))) {
        suppressed++;
        continue;
      }
      const key = JSON.stringify([row.id, price.checkin, price.checkout, price.currency]);
      if (seen.has(key)) continue;
      if (addedResults >= MAX_PARTIAL_RESULTS) {
        seen.add(key);
        omitted++;
        continue;
      }
      const availability = describeAvailability(price, options);
      if (add({ ...row, availability, discovery: {
        source: "shorter_stay_search", searchCheckin: outcome.report.checkin, searchCheckout: outcome.report.checkout,
      } })) { added++; addedResults++; }
    }
    outcome.report.eligibleResults = eligibleResults;
    outcome.report.addedResults = added;
    outcome.report.omittedResults = omitted;
    outcome.report.suppressedFullStayResults = suppressed;
    omittedResults += omitted;
    suppressedFullStayResults += suppressed;
  }
  // Keep Airbnb's order within equally complete stays; never rank a cheap short
  // quote ahead of a full stay just because their incomparable totals differ.
  const rank = (row: any) => row.availability?.matchType === "exact_dates" ? 0 : row.availability?.matchType === "partial_stay" ? 1 : 2;
  searchResults.sort((a, b) => rank(a) - rank(b) ||
    (rank(a) === 1 ? (b.availability.coveredRequestedNights ?? 0) - (a.availability.coveredRequestedNights ?? 0) : 0));
  const completed = outcomes.filter(o => o.report.status === "completed").length;
  const failed = outcomes.filter(o => o.report.status === "failed").length;
  const skipped = outcomes.filter(o => o.report.status === "skipped").length;
  return {
    ...primary,
    searchResults,
    ...(primary.ratingFilter ? { ratingFilter: combineRatingReports([
      primary.ratingFilter,
      ...outcomes.flatMap(outcome => outcome.page?.ratingFilter ? [outcome.page.ratingFilter] : []),
    ]) } : {}),
    availabilityFilter: {
      ...primary.availabilityFilter,
      excludedResultsScope: primary.availabilityFilter?.excludedResultsScope ?? "primary_search_page",
      partialStayResults: searchResults.filter(r => r.availability?.matchType === "partial_stay").length,
    },
    partialStayDiscovery: {
      enabled: true,
      requestedCheckin: options.checkin, requestedCheckout: options.checkout,
      minPartialNights: minNights, maxPartialSearches: maxSearches,
      candidateWindows: plan.candidateWindows, plannedSearches: plan.windows.length,
      completedSearches: completed, failedSearches: failed, skippedSearches: skipped,
      unsearchedWindows: plan.candidateWindows - completed,
      allWindowsSearched: completed === plan.candidateWindows,
      addedResults,
      resultLimit: MAX_PARTIAL_RESULTS, omittedResults, suppressedFullStayResults,
      resultsLimitedToFirstPage: true,
      searches: outcomes.map(o => o.report),
      note: "Only the first page of each planned window is searched, longest stays first. Unsearched or failed windows and empty pages do not prove no availability. Each quote covers only its own dates; separate results do not form a confirmed split stay.",
    },
  };
}
