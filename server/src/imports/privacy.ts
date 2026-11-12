/**
 * Demo-data safeguards. ReliefRelay's demo organisation may only hold synthetic records, so anything that
 * looks like a real person's contact detail is rejected before it is stored. These checks catch email
 * addresses and phone numbers; they cannot reliably detect names or medical information.
 */

const RESERVED_SECOND_LEVEL = ['example.com', 'example.org', 'example.net'];
const RESERVED_TLDS = ['test', 'example', 'invalid'];

/** RFC 2606 and RFC 6761 reserved domains, which can never belong to a real mailbox. */
export function isReservedEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (RESERVED_SECOND_LEVEL.some((reserved) => d === reserved || d.endsWith(`.${reserved}`))) return true;
  const tld = d.split('.').at(-1) ?? '';
  return RESERVED_TLDS.includes(tld);
}

/**
 * Fictional numbers reserved for drama and testing:
 * UK Ofcom range 07700 900000 to 900999, and US 555-0100 to 555-0199 in any area code.
 */
export function isFictionalPhoneNumber(value: string): boolean {
  const digits = value.replace(/[\s().-]/g, '');
  return /^\+447700900\d{3}$/.test(digits) || /^07700900\d{3}$/.test(digits) || /^\+1\d{3}55501\d{2}$/.test(digits);
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const INTERNATIONAL_PHONE_IN_TEXT = /(?:\+|\b00)\d[\d\s().-]{6,18}\d/g;
const NATIONAL_PHONE_CELL = /^0[\d\s().-]{9,16}$/;

export type ContactKind = 'email' | 'phone';

export interface ContactDetail {
  kind: ContactKind;
  value: string;
  synthetic: boolean;
}

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** Finds email addresses and phone numbers in a single cell of text. */
export function findContactDetails(text: string): ContactDetail[] {
  const found: ContactDetail[] = [];
  for (const match of text.matchAll(EMAIL_IN_TEXT)) {
    found.push({ kind: 'email', value: match[0], synthetic: isReservedEmailDomain(match[1] ?? '') });
  }
  const withoutEmails = text.replace(EMAIL_IN_TEXT, ' ');
  for (const match of withoutEmails.matchAll(INTERNATIONAL_PHONE_IN_TEXT)) {
    if (digitCount(match[0]) >= 8) found.push({ kind: 'phone', value: match[0], synthetic: isFictionalPhoneNumber(match[0]) });
  }
  const trimmed = withoutEmails.trim();
  if (NATIONAL_PHONE_CELL.test(trimmed) && digitCount(trimmed) >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    found.push({ kind: 'phone', value: trimmed, synthetic: isFictionalPhoneNumber(trimmed) });
  }
  return found;
}

export interface ContactScreenHit {
  rowNumber: number;
  column: string;
  kind: ContactKind;
}

/**
 * Screens every cell of an uploaded file, including the header row and unmapped columns, before anything is
 * stored. Returns where real-looking contact details were found; the values themselves are never echoed back.
 */
export function screenForRealContactDetails(headers: string[], rows: { rowNumber: number; values: string[] }[]): ContactScreenHit[] {
  const hits: ContactScreenHit[] = [];
  const check = (rowNumber: number, values: string[]) => {
    values.forEach((cell, index) => {
      for (const detail of findContactDetails(cell)) {
        if (!detail.synthetic) hits.push({ rowNumber, column: headers[index] ?? `Column ${index + 1}`, kind: detail.kind });
      }
    });
  };
  check(1, headers);
  for (const row of rows) check(row.rowNumber, row.values);
  return hits;
}
