import { dateNights } from "./pricing.js";

export const SORT_FIELDS = ["recommended", "nightly_price", "total_price", "rating", "review_count", "nights_covered"] as const;
type SortField = typeof SORT_FIELDS[number];
type Options = { sortBy?: SortField; sortOrder?: "asc" | "desc"; checkin?: string; checkout?: string };

export function validateSortOptions(params: Record<string, any>) {
  if (params.sortBy !== undefined && !SORT_FIELDS.includes(params.sortBy)) throw new Error(`sortBy must be one of: ${SORT_FIELDS.join(", ")}`);
  if (params.sortOrder !== undefined && params.sortOrder !== "asc" && params.sortOrder !== "desc") throw new Error("sortOrder must be asc or desc");
  if (params.sortOrder !== undefined && (params.sortBy === undefined || params.sortBy === "recommended")) throw new Error("sortOrder requires an explicit sortBy other than recommended");
  if (params.sortBy === "nights_covered" && dateNights(params.checkin, params.checkout) === null) throw new Error("nights_covered sorting requires valid checkin and checkout dates");
}

export function sortSearchResults<T extends Record<string, any>>(rows: T[], options: Options) {
  validateSortOptions(options);
  const sortBy = options.sortBy ?? "recommended";
  const priceSort = sortBy === "nightly_price" || sortBy === "total_price";
  const order = sortBy === "recommended" ? null : options.sortOrder ?? (priceSort ? "asc" : "desc");
  const groups = new Map<string, { currency: string; checkin?: string; checkout?: string; results: number }>();
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const indexed = rows.map((row, index) => {
    let value: number | null = null;
    let group: string | null = null;
    if (priceSort) {
      const price = row.pricing;
      value = number(sortBy === "nightly_price" ? price?.averageNightlyTotal : price?.stayTotal);
      const currency = price?.currency;
      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || price?.datesMatchPrice === false) value = null;
      if (sortBy === "total_price" && (price?.datesMatchPrice !== true || dateNights(price?.checkin, price?.checkout) === null)) value = null;
      if (value !== null) {
        const context = sortBy === "total_price" ? { currency, checkin: price.checkin, checkout: price.checkout } : { currency };
        group = JSON.stringify(context);
        const entry = groups.get(group) ?? { ...context, results: 0 };
        entry.results++;
        groups.set(group, entry);
      }
    } else if (sortBy === "rating") value = number(row.rating);
    else if (sortBy === "review_count") value = number(row.reviewCount);
    else if (sortBy === "nights_covered") value = number(row.availability?.coveredRequestedNights);
    return { row, index, value, group };
  });
  const groupOrder = new Map([...groups.keys()].map((key, index) => [key, index]));
  if (order !== null) indexed.sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === null && b.value === null ? a.index - b.index : a.value === null ? 1 : -1;
    const groupDifference = priceSort ? groupOrder.get(a.group!)! - groupOrder.get(b.group!)! : 0;
    return groupDifference || (order === "asc" ? a.value - b.value : b.value - a.value) || a.index - b.index;
  });
  return {
    searchResults: indexed.map(entry => entry.row),
    sorting: {
      applied: sortBy !== "recommended", sortBy, sortOrder: order,
      execution: "local", scope: "fetched_results", resultsConsidered: rows.length,
      unrankedResults: sortBy === "recommended" ? 0 : indexed.filter(entry => entry.value === null).length,
      priceBasis: sortBy === "nightly_price" ? "averageNightlyTotal" : sortBy === "total_price" ? "stayTotal" : null,
      groups: [...groups.values()],
      note: sortBy === "recommended"
        ? "Preserves the existing order, including full-stay and coverage priority when shorter-stay discovery is enabled."
        : "Sorted locally after filtering, pagination and shorter-stay discovery; this is not an Airbnb-wide ranking and does not fetch additional pages. Missing or unusable values go last; ties keep the prior order. Explicit sorting overrides the default full-stay priority. Price groups remain in first-appearance order, with no currency conversion. Stay totals are compared only for identical quoted dates and currency. Nightly price uses the average quoted stay total per night, never the base rate; quotes may differ in tax/fee inclusion and may be approximate. Pagination cursors still follow Airbnb's original order.",
    },
  };
}
