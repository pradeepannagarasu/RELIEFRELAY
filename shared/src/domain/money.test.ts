import { describe, expect, it } from 'vitest';
import { formatMoney, money, parseDecimalAmount, sumMoney, toDecimalString } from './money';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money('USD', 10.5)).toThrow(RangeError);
  });

  it('sums per currency and never mixes currencies', () => {
    const totals = sumMoney([money('USD', 1000), money('EUR', 250), money('USD', 1)]);
    expect(totals).toEqual([money('EUR', 250), money('USD', 1001)]);
  });

  it('returns an empty list for no values', () => {
    expect(sumMoney([])).toEqual([]);
  });

  it('parses decimal strings without floating point error', () => {
    expect(parseDecimalAmount('120.5', 'USD')).toEqual(money('USD', 12050));
    expect(parseDecimalAmount('0.07', 'USD')).toEqual(money('USD', 7));
    expect(parseDecimalAmount(' 75 ', 'USD')).toEqual(money('USD', 7500));
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', '-5', '1.234', '1,000.00', 'abc', '1e3', '.5']) {
      expect(parseDecimalAmount(bad, 'USD')).toBeNull();
    }
  });

  it('formats provider decimal strings', () => {
    expect(toDecimalString(money('USD', 12050))).toBe('120.50');
    expect(toDecimalString(money('USD', 7))).toBe('0.07');
  });

  it('formats for display', () => {
    expect(formatMoney(money('USD', 123456), 'en-US')).toBe('$1,234.56');
  });
});
