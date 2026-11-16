import { dateNights } from "./pricing.js";

type TotalPriceOptions = { maxTotalPrice?: number; currency?: string };

export function validateTotalPriceOptions(params: Record<string, any>) {
  if (params.maxTotalPrice === undefined) return;
  if (typeof params.maxTotalPrice !== "number" || !Number.isFinite(params.maxTotalPrice) || params.maxTotalPrice < 0 || params.maxTotalPrice > Number.MAX_SAFE_INTEGER) {
    throw new Error("maxTotalPrice must be a finite non-negative number no greater than Number.MAX_SAFE_INTEGER");
  }
  if (typeof params.currency !== "string" || !/^[A-Z]{3}$/.test(params.currency)) throw new Error("maxTotalPrice requires currency as a three-letter uppercase code, e.g. USD");
}

export function filterByTotalPrice<T extends { pricing?: any }>(rows: T[], options: TotalPriceOptions) {
  validateTotalPriceOptions(options);
  const applied = options.maxTotalPrice !== undefined;
  const counts = {
    unknownTotalExcluded: 0, unknownCurrencyExcluded: 0, currencyMismatchExcluded: 0,
    unverifiedDatesExcluded: 0, overBudgetExcluded: 0,
  };
  const searchResults = rows.filter(row => {
    if (!applied) return true;
    const price = row.pricing;
    const amount = price?.stayTotal;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) { counts.unknownTotalExcluded++; return false; }
    if (typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency)) { counts.unknownCurrencyExcluded++; return false; }
    if (price.currency !== options.currency) { counts.currencyMismatchExcluded++; return false; }
    if (dateNights(price.checkin, price.checkout) === null || price.datesMatchPrice !== true) { counts.unverifiedDatesExcluded++; return false; }
    if (amount > options.maxTotalPrice!) { counts.overBudgetExcluded++; return false; }
    return true;
  });
  return {
    searchResults,
    totalPriceFilter: {
      applied, maxTotalPrice: options.maxTotalPrice ?? null, currency: options.currency ?? null,
      execution: "local", scope: "fetched_page", basis: "quoted_stay_total",
      pagesExamined: 1, examinedResults: rows.length, excludedResults: rows.length - searchResults.length,
      ...counts,
      note: "Inclusive cap on each quoted stay total, after date/rating filtering and before pagination targets, deduplication and sorting. Zero is a zero budget; omit to disable. Unknown totals/currencies, other currencies and dates inconsistent with the price are excluded; no currency conversion or nightly-rate estimates. Exclusion reasons are counted once per row, in the reported order. Partial-stay totals cover only their quoted dates, not the entire requested trip. Display totals may be approximate; inspect pricing.taxesIncluded and pricing.feesIncluded. Passing this filter does not guarantee the final checkout amount. Repeat the cap and currency when continuing with a cursor.",
    },
  };
}

export type TotalPriceFilterReport = ReturnType<typeof filterByTotalPrice>["totalPriceFilter"];

export function combineTotalPriceReports(reports: TotalPriceFilterReport[]): TotalPriceFilterReport {
  const sum = (key: "pagesExamined" | "examinedResults" | "excludedResults" | "unknownTotalExcluded" | "unknownCurrencyExcluded" | "currencyMismatchExcluded" | "unverifiedDatesExcluded" | "overBudgetExcluded") => reports.reduce((total, report) => total + report[key], 0);
  return {
    ...reports[0], scope: "all_fetched_pages",
    pagesExamined: sum("pagesExamined"), examinedResults: sum("examinedResults"), excludedResults: sum("excludedResults"),
    unknownTotalExcluded: sum("unknownTotalExcluded"), unknownCurrencyExcluded: sum("unknownCurrencyExcluded"),
    currencyMismatchExcluded: sum("currencyMismatchExcluded"), unverifiedDatesExcluded: sum("unverifiedDatesExcluded"),
    overBudgetExcluded: sum("overBudgetExcluded"),
  };
}
