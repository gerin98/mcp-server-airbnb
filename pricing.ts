export interface PricingContext {
  currency: string | null;
  requestedCurrency?: string;
  checkin?: string;
  checkout?: string;
}

// Read Airbnb's resolved currency, never infer an ISO code from an ambiguous "$".
export function resolveCurrency(injector: unknown): string | null {
  if (!injector || typeof injector !== "object") return null;
  const codes = new Set<string>();
  for (const entries of Object.values(injector)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const code = Array.isArray(entry) ? entry[1]?.serverDeterminedCurrency : undefined;
      if (typeof code === "string" && /^[A-Z]{3}$/.test(code)) codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}

export function dateNights(checkin: unknown, checkout: unknown): number | null {
  const timestamp = (value: unknown): number | null => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  };
  const start = timestamp(checkin);
  const end = timestamp(checkout);
  return start !== null && end !== null && end > start ? (end - start) / 86400000 : null;
}

// Requests use en-US. Reject unfamiliar numeric formats instead of guessing
// whether a comma is a decimal separator. Raw display strings remain available.
function money(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\u2212/g, "-");
  const tokens = normalized.match(/[+-]?\d[\d,.]*/g);
  if (tokens?.length !== 1) return null;
  const token = tokens[0];
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d+)?$/.test(token)) return null;
  let amount = Number(token.replace(/,/g, ""));
  if (/^\s*[-−]/.test(value) || /^\s*\(.*\)\s*$/.test(value)) amount = -Math.abs(amount);
  return Number.isFinite(amount) ? amount : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function inclusion(labels: string[], subject: "taxes" | "fees"): boolean | null {
  const joined = labels.join(" ").toLowerCase();
  const other = subject === "taxes" ? "fees" : "taxes";
  const excluded = new RegExp(`(?:before|excluding|excludes|without) (?:all )?(?:${other} and )?${subject}|${subject} (?:are )?(?:not included|excluded)`).test(joined);
  const included = new RegExp(`(?:including|includes|inclusive of) (?:all )?(?:${other} and )?${subject}|${subject} (?:are )?included`).test(joined);
  return excluded === included ? null : included;
}

export function extractPricing(result: any, context: PricingContext) {
  const price = result?.structuredDisplayPrice ?? {};
  const primary = price.primaryLine ?? {};
  const secondary = price.secondaryLine ?? {};
  const groups = Array.isArray(price.explanationData?.priceDetails) ? price.explanationData.priceDetails : [];
  const rawItems: any[] = groups.flatMap((group: any) => Array.isArray(group?.items) ? group.items : []).filter((item: any) => item && typeof item === "object");
  const nightlyPattern = /^(\d+) nights?\s*[x×]\s*(.+)$/i;
  const breakdown = rawItems.map((item: any) => {
    const label = text(item.description);
    const accessibilityLabel = text(item.accessibilityLabel);
    const displayAmount = text(item.priceString);
    const isTotal = /^total(?: price| cost)?(?:$| (?:before|after|including|excluding)\b)|^price after discount$/i.test(label ?? "")
      || /\btotal(?:$| (?:before|after|including|excluding|for)\b)/i.test(accessibilityLabel ?? "");
    const kind = label && nightlyPattern.test(label) ? "nightly_subtotal"
      : isTotal ? "total"
      : /\bdiscount\b/i.test(label ?? "") ? "discount"
      : /\btax(?:es)?\b|\bvat\b/i.test(label ?? "") ? "tax"
      : /\bfee\b|\bfees\b/i.test(label ?? "") ? "fee" : "other";
    return { kind, label, amount: money(displayAmount), displayAmount, originalAmount: money(item.originalPriceString), accessibilityLabel };
  });
  const notes: string[] = groups.map((group: any) => text(group?.content)).filter((value: string | null): value is string => value !== null);
  const nightlyItems = breakdown.filter(item => item.kind === "nightly_subtotal");
  const nightlyMatch = nightlyItems.length === 1 ? nightlyItems[0].label?.match(nightlyPattern) : null;
  const breakdownRate = nightlyMatch ? money(nightlyMatch[2]) : null;
  const isNightlyDisplay = /^(?:per )?night$/i.test(primary.qualifier ?? "") || /\bper night\b/i.test(primary.accessibilityLabel ?? "");
  const displayRate = isNightlyDisplay ? money(primary.discountedPrice ?? primary.price) : null;
  // A headline nightly price may already include fees; do not label it as base rent.
  const baseNightlyRate = breakdownRate;
  const overrides = result?.listingParamOverrides;
  const hasOverrides = dateNights(overrides?.checkin, overrides?.checkout) !== null;
  const hasOverrideDateFields = overrides?.checkin != null || overrides?.checkout != null;
  const hasRequestedDates = dateNights(context.checkin, context.checkout) !== null;
  const useRequestedDates = hasRequestedDates && !hasOverrideDateFields;
  const checkin = hasOverrides ? overrides.checkin : useRequestedDates ? context.checkin! : null;
  const checkout = hasOverrides ? overrides.checkout : useRequestedDates ? context.checkout! : null;
  const datesSource = hasOverrides
    ? hasRequestedDates && checkin === context.checkin && checkout === context.checkout ? "requested"
      : hasRequestedDates ? "airbnb_override" : "airbnb_suggested"
    : useRequestedDates ? "requested" : "unknown";
  const datedNights = dateNights(checkin, checkout);
  const displayedNights = `${primary.qualifier ?? ""} ${primary.accessibilityLabel ?? ""} ${secondary.accessibilityLabel ?? ""}`.match(/(?:for|total for) (\d+) nights?\b/i);
  const nights = displayedNights ? Number(displayedNights[1]) : nightlyMatch ? Number(nightlyMatch[1]) : datedNights;
  const validNights = nights !== null && nights > 0 ? nights : null;
  const datesMatchPrice = datedNights !== null && validNights !== null ? datedNights === validNights : null;
  if (datesMatchPrice === false) notes.push("The displayed night count differs from the date range; verify the quoted stay on Airbnb.");

  const totalItems = breakdown.filter(item => item.kind === "total" && item.amount !== null);
  const labels = [text(primary.accessibilityLabel), text(secondary.accessibilityLabel), ...totalItems.map(item => item.accessibilityLabel), text(price.explanationData?.subtitle), ...notes].filter((value): value is string => value !== null);
  // A nightly primary line is not a stay total, even when dates are supplied.
  const totalLine = [primary, secondary].find(line =>
    /\bfor \d+ nights?\b|\btotal\b/i.test(`${line.qualifier ?? ""} ${line.accessibilityLabel ?? ""}`)
  ) ?? (price.displayPriceStyle === "TOTAL_ONLY" ? primary : null);
  const explicitTotal = totalItems.length === 1 ? totalItems[0].amount : null;
  const displayTotal = totalLine ? money(totalLine.discountedPrice ?? totalLine.price)
    ?? money(text(totalLine.accessibilityLabel)?.split(/ for | total|, originally/i)[0]) : null;
  const stayTotal = explicitTotal ?? displayTotal;
  const stayTotalSource = explicitTotal !== null ? "breakdown" : displayTotal !== null ? "display" : null;
  const originalStayTotal = totalLine ? money(totalLine.originalPrice) : null;
  const currency = context.currency;
  const currencyMatchesRequest = context.requestedCurrency && currency ? context.requestedCurrency === currency : null;
  if (currencyMatchesRequest === false) notes.push(`Airbnb returned ${currency} instead of the requested ${context.requestedCurrency}.`);
  let averageNightlyTotal: number | null = null;
  if (stayTotal !== null && validNights !== null && currency) {
    const digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    averageNightlyTotal = Number((stayTotal / validNights).toFixed(digits));
  }
  return {
    currency,
    requestedCurrency: context.requestedCurrency ?? null,
    currencyMatchesRequest,
    checkin, checkout, datesSource, nights: validNights, datesMatchPrice,
    baseNightlyRate,
    displayedNightlyRate: displayRate,
    stayTotal,
    stayTotalSource,
    stayTotalIsApproximate: stayTotalSource === null ? null : stayTotalSource === "display",
    averageNightlyTotal,
    originalStayTotal,
    taxesIncluded: inclusion(labels, "taxes"),
    feesIncluded: inclusion(labels, "fees"),
    fees: breakdown.filter(item => item.kind === "fee"),
    taxes: breakdown.filter(item => item.kind === "tax"),
    discounts: breakdown.filter(item => item.kind === "discount"),
    priceReductions: breakdown.filter(item => item.originalAmount !== null && item.amount !== null && item.originalAmount > item.amount).map(item => ({
      label: item.label, originalAmount: item.originalAmount, currentAmount: item.amount,
      // Preserve the source amounts; this comparison is not an extra line-item discount.
      amount: Number((item.originalAmount! - item.amount!).toFixed(6))
    })),
    breakdown,
    display: { primary: text(primary.accessibilityLabel), secondary: text(secondary.accessibilityLabel) },
    notes,
  };
}
