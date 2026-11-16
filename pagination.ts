import { combineRatingReports, RatingFilterReport } from "./ratings.js";
import { combineTotalPriceReports, TotalPriceFilterReport } from "./total-price.js";

export const DEFAULT_MAX_PAGES = 3;
export const MAX_PAGES = 5;
export const PAGINATION_BUDGET_MS = 15000;

export function validatePaginationOptions(params: Record<string, any>) {
  for (const [name, max] of [["targetResults", 100], ["maxPages", MAX_PAGES]] as const) {
    const value = params[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max)) {
      throw new Error(`${name} must be a whole number from 1 to ${max}`);
    }
  }
  if (params.maxPages !== undefined && params.targetResults === undefined) throw new Error("maxPages requires targetResults");
  if (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor.trim())) throw new Error("cursor must be a nonempty string");
}

type Page = { searchResults: any[]; paginationInfo?: any; ratingFilter?: RatingFilterReport; totalPriceFilter?: TotalPriceFilterReport; availabilityFilter?: any; retrievedAt?: string };

// Use only provider-issued cursors. Never infer offsets from the result count:
// local filters can remove every result while later pages still have matches.
function continuation(page: Page, cursor: string | null): { cursor: string | null; reason: string } {
  const cursors = page.paginationInfo?.pageCursors;
  if (!Array.isArray(cursors) || cursors.some(c => typeof c !== "string" || !c)) return { cursor: null, reason: "pagination_unavailable" };
  if (!cursors.length) return { cursor: null, reason: "no_more_cursors" };
  const index = cursor === null ? 0 : cursors.indexOf(cursor);
  if (index < 0) return { cursor: null, reason: "cursor_unrecognized" };
  return { cursor: cursors[index + 1] ?? null, reason: "no_more_cursors" };
}

export async function paginateSearch(
  primary: Page, primaryUrl: URL,
  options: { targetResults: number; maxPages?: number },
  search: (url: URL, timeoutMs: number) => Promise<Page>,
  now: () => number = Date.now,
) {
  validatePaginationOptions(options);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const deadline = now() + PAGINATION_BUDGET_MS;
  const searchResults: any[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const pages: any[] = [];
  const successful: Page[] = [];
  let duplicatesRemoved = 0;
  let current = primary;
  let cursor = primaryUrl.searchParams.get("cursor");
  let nextCursor: string | null = null;
  let stopReason = "";
  let error: string | null = null;
  while (true) {
    successful.push(current);
    if (cursor) visited.add(cursor);
    else if (typeof current.paginationInfo?.pageCursors?.[0] === "string") visited.add(current.paginationInfo.pageCursors[0]);
    const before = searchResults.length;
    for (const row of current.searchResults) {
      const key = JSON.stringify([row.id, row.pricing?.checkin, row.pricing?.checkout, row.pricing?.currency]);
      if (seen.has(key)) { duplicatesRemoved++; continue; }
      seen.add(key);
      searchResults.push(row);
    }
    pages.push({ cursor, status: "completed", returnedResults: current.searchResults.length,
      addedResults: searchResults.length - before, retrievedAt: current.retrievedAt ?? null,
      paginationInfo: current.paginationInfo ?? null, ratingFilter: current.ratingFilter,
      totalPriceFilter: current.totalPriceFilter,
      availabilityFilter: current.availabilityFilter });
    const next = continuation(current, cursor);
    nextCursor = next.cursor;
    if (nextCursor && visited.has(nextCursor)) { nextCursor = null; stopReason = "repeated_cursor"; break; }
    if (searchResults.length >= options.targetResults) { stopReason = "target_reached"; break; }
    if (!nextCursor) { stopReason = next.reason; break; }
    if (successful.length >= maxPages) { stopReason = "page_limit"; break; }
    const remaining = deadline - now();
    if (remaining <= 0) { stopReason = "time_limit"; break; }
    const url = new URL(primaryUrl);
    url.searchParams.set("cursor", nextCursor);
    try {
      const page = await search(url, Math.min(remaining, 8000));
      if (!Array.isArray(page.searchResults)) throw new Error("Search returned no result array");
      current = page;
      cursor = nextCursor;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      pages.push({ cursor: nextCursor, status: "failed", error });
      stopReason = now() >= deadline ? "time_limit" : "page_failed";
      break;
    }
  }
  const ratingReports = successful.flatMap(page => page.ratingFilter ? [page.ratingFilter] : []);
  const totalPriceReports = successful.flatMap(page => page.totalPriceFilter ? [page.totalPriceFilter] : []);
  return {
    ...primary, searchResults,
    paginationInfo: current.paginationInfo,
    ...(ratingReports.length ? { ratingFilter: combineRatingReports(ratingReports) } : {}),
    ...(totalPriceReports.length ? { totalPriceFilter: combineTotalPriceReports(totalPriceReports) } : {}),
    availabilityFilter: {
      ...primary.availabilityFilter,
      excludedResults: successful.reduce((total, page) => total + (page.availabilityFilter?.excludedResults ?? 0), 0),
      excludedResultsScope: "primary_search_pages",
      partialStayResults: searchResults.filter(row => row.availability?.matchType === "partial_stay").length,
    },
    autoPagination: {
      enabled: true, targetResults: options.targetResults, maxPages,
      pagesFetched: successful.length, pagesAttempted: pages.length,
      returnedResults: searchResults.length, duplicatesRemoved,
      targetReached: searchResults.length >= options.targetResults,
      stopReason, nextCursor, error, extraPageBudgetMs: PAGINATION_BUDGET_MS, pages,
      note: "Counts cover the main search before shorter-stay discovery. Complete pages are returned, so the target may be exceeded. Continue with nextCursor and the same filters (disable partial-stay discovery when using a cursor). A failed page's cursor is retained for retry. No more cursors does not prove that all Airbnb inventory was searched.",
    },
  };
}
