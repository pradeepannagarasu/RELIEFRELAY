export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Monetary amount in integer minor units (cents). Never use floating point for money. */
export interface Money {
  currency: CurrencyCode;
  minor: number;
}

/** Totals grouped by currency. Amounts in different currencies are never added together. */
export type MoneyTotals = Money[];

export function money(currency: CurrencyCode, minor: number): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Money amount must be an integer number of minor units, received ${minor}`);
  }
  return { currency, minor };
}

export function sumMoney(values: Iterable<Money>): MoneyTotals {
  const totals = new Map<CurrencyCode, number>();
  for (const value of values) {
    totals.set(value.currency, (totals.get(value.currency) ?? 0) + value.minor);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => money(currency, minor));
}

export function formatMoney(value: Money, locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value.minor / 100);
}

const DECIMAL_AMOUNT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** Parses a decimal string such as "120.50" (CSV or PayPal format) into minor units without float arithmetic. */
export function parseDecimalAmount(value: string, currency: CurrencyCode): Money | null {
  const match = DECIMAL_AMOUNT.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '0').padEnd(2, '0'));
  return money(currency, whole * 100 + fraction);
}

/** Formats minor units as the decimal string PayPal expects, e.g. 12050 -> "120.50". */
export function toDecimalString(value: Money): string {
  const sign = value.minor < 0 ? '-' : '';
  const abs = Math.abs(value.minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
