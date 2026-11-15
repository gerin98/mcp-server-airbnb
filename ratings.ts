export interface RatingOptions {
  minRating?: number;
  minReviewCount?: number;
}

export function validateRatingOptions(params: Record<string, any>) {
  if (params.minRating !== undefined && (typeof params.minRating !== "number" || !Number.isFinite(params.minRating) || params.minRating < 0 || params.minRating > 5)) {
    throw new Error("minRating must be a number from 0 to 5");
  }
  if (params.minReviewCount !== undefined && (!Number.isSafeInteger(params.minReviewCount) || params.minReviewCount < 0)) {
    throw new Error("minReviewCount must be a non-negative whole number");
  }
}

function stars(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number : null;
}

function count(value: string | undefined): number | null {
  if (value === undefined || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

// Requests use en-US. Prefer the accessibility label's exact count over compact
// display text such as "1K"; never turn an approximation into an exact threshold.
export function extractRating(result: any): { rating: number | null; reviewCount: number | null } {
  const a11y = typeof result?.avgRatingA11yLabel === "string" ? result.avgRatingA11yLabel.trim() : "";
  const display = typeof result?.avgRatingLocalized === "string" ? result.avgRatingLocalized.trim() : "";
  const a11yRating = stars(a11y.match(/^(\d+(?:\.\d+)?)\s+out of 5 average rating(?:\s*,|\s*$)/i)?.[1]);
  const a11yCount = count(a11y.match(/^(?:\d+(?:\.\d+)?\s+out of 5 average rating,\s*)?(\d+(?:,\d{3})*)\s+reviews?\s*$/i)?.[1]);
  const compact = display.match(/^(\d+(?:\.\d+)?)(?:\s*\(([^()]*)\))?$/);
  const noReviews = /^(?:no reviews(?: yet)?|0 reviews)$/i.test(a11y) || /^(?:no reviews(?: yet)?|0 reviews)$/i.test(display);
  const reviewCount = noReviews ? 0 : a11yCount ?? count(compact?.[2]);
  const rating = reviewCount === 0 ? null : a11yRating ?? stars(compact?.[1]);
  return { rating, reviewCount };
}

export function filterByRating<T extends { rating: number | null; reviewCount: number | null }>(rows: T[], options: RatingOptions) {
  validateRatingOptions(options);
  const needsRating = (options.minRating ?? 0) > 0;
  const needsCount = (options.minReviewCount ?? 0) > 0;
  let missingRatingExcluded = 0;
  let missingReviewCountExcluded = 0;
  const searchResults = rows.filter(row => {
    const unknownRating = needsRating && row.rating === null;
    const unknownCount = needsCount && row.reviewCount === null;
    if (unknownRating) missingRatingExcluded++;
    if (unknownCount) missingReviewCountExcluded++;
    return (!needsRating || (row.rating !== null && row.rating >= options.minRating!)) &&
      (!needsCount || (row.reviewCount !== null && row.reviewCount >= options.minReviewCount!));
  });
  return {
    searchResults,
    ratingFilter: {
      applied: needsRating || needsCount,
      minRating: options.minRating ?? null,
      minReviewCount: options.minReviewCount ?? null,
      execution: "local",
      scope: "fetched_page",
      pagesExamined: 1,
      examinedResults: rows.length,
      excludedResults: rows.length - searchResults.length,
      missingRatingExcluded,
      missingReviewCountExcluded,
      note: "Filters apply locally after date filtering to fetched rows, before deduplication. Unknown values fail only an active threshold; zero disables that threshold. Missing-value counts may overlap. The original cursor is preserved; repeat the same thresholds on subsequent pages. An empty page is not proof that no qualifying listings exist.",
    },
  };
}

export type RatingFilterReport = ReturnType<typeof filterByRating>["ratingFilter"];

export function combineRatingReports(reports: RatingFilterReport[]): RatingFilterReport {
  const sum = (key: "pagesExamined" | "examinedResults" | "excludedResults" | "missingRatingExcluded" | "missingReviewCountExcluded") => reports.reduce((total, report) => total + report[key], 0);
  return {
    ...reports[0], scope: "all_fetched_pages",
    pagesExamined: sum("pagesExamined"), examinedResults: sum("examinedResults"),
    excludedResults: sum("excludedResults"), missingRatingExcluded: sum("missingRatingExcluded"),
    missingReviewCountExcluded: sum("missingReviewCountExcluded"),
  };
}
