/**
 * Locale-aware formatting helpers built on the `Intl` APIs. They read the
 * current locale from the runtime store so callers never thread a locale
 * argument through their code.
 */

import { getLocale, type Locale } from "./runtime.js";

/** Map an internal locale to its BCP-47 tag for the `Intl` APIs. */
export function localeTag(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

export function formatDate(
  date: Date | number | string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const value = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(localeTag(getLocale()), opts).format(value);
}

export function formatNumber(
  value: number,
  opts?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(localeTag(getLocale()), opts).format(value);
}

export function formatCurrency(
  value: number,
  currency: string = "USD",
  opts?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(localeTag(getLocale()), {
    style: "currency",
    currency,
    ...opts,
  }).format(value);
}
