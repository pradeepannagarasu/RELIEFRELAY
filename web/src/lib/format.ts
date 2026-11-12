import type { Money, MoneyTotals } from '@shared/domain/money';

const LOCALE = 'en-GB';

const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});
const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const integerFormat = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 });

export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatCount = (value: number) => integerFormat.format(value);
export const formatPercent = (ratio: number) => percentFormat.format(ratio);

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = (Date.parse(iso) - now.getTime()) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

const codeFormats = new Map<string, Intl.NumberFormat>();

/** An amount with its ISO currency code, e.g. "GBP 12.50", so GBP, USD and EUR are never confused. */
export function formatMoneyValue(value: Money): string {
  let format = codeFormats.get(value.currency);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: value.currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    codeFormats.set(value.currency, format);
  }
  return format.format(value.minor / 100);
}

/**
 * Per-currency subtotals, e.g. "GBP 12.50 · USD 5,630.00". Each currency is a separate subtotal: amounts in different
 * currencies are never added together, and there is no combined total. With no records there is no currency to show.
 */
export function formatMoneyTotals(totals: MoneyTotals): string {
  if (totals.length === 0) return 'None';
  return totals.map(formatMoneyValue).join(' · ');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}
