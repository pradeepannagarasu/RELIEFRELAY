import { parse } from 'csv-parse/sync';
import { IMPORT_LIMITS } from '@shared/domain/imports';
import { sha256Hex } from '../db/connection';

export type CsvFileErrorCode =
  | 'empty_file'
  | 'file_too_large'
  | 'binary_content'
  | 'invalid_encoding'
  | 'malformed_csv'
  | 'missing_header'
  | 'blank_header'
  | 'duplicate_header'
  | 'too_many_columns'
  | 'too_many_rows'
  | 'no_data_rows';

export class CsvFileError extends Error {
  override name = 'CsvFileError';
  constructor(
    readonly code: CsvFileErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ParsedCsvRow {
  /** Spreadsheet row number; the header is row 1. */
  rowNumber: number;
  values: string[];
}

export interface ParsedCsvFile {
  sha256: string;
  sizeBytes: number;
  headers: string[];
  rows: ParsedCsvRow[];
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Parses an uploaded CSV file defensively. Nothing is guessed: anything ambiguous is reported, not repaired. */
export function parseCsvFile(bytes: Uint8Array): ParsedCsvFile {
  if (bytes.byteLength === 0) throw new CsvFileError('empty_file', 'The file is empty.');
  if (bytes.byteLength > IMPORT_LIMITS.maxBytes) {
    throw new CsvFileError('file_too_large', `The file is larger than the ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB limit.`);
  }
  if (bytes.includes(0)) {
    throw new CsvFileError('binary_content', 'The file contains binary data. Export it from your spreadsheet as CSV (UTF-8).');
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new CsvFileError('invalid_encoding', 'The file is not valid UTF-8 text. Export it from your spreadsheet as CSV (UTF-8).');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let records: string[][];
  try {
    records = parse(text, {
      relax_column_count: true,
      skip_empty_lines: false,
      to: IMPORT_LIMITS.maxRows + 2,
    }) as string[][];
  } catch (error) {
    const line = typeof error === 'object' && error && 'lines' in error ? Number((error as { lines: unknown }).lines) : null;
    throw new CsvFileError(
      'malformed_csv',
      `The file could not be read as CSV${line ? ` near line ${line}` : ''}. Check for an unclosed quotation mark.`,
      line ? { line } : undefined,
    );
  }

  const [headerRecord, ...dataRecords] = records;
  if (!headerRecord || headerRecord.every((cell) => cell.trim() === '')) {
    throw new CsvFileError('missing_header', 'The first row must contain column headings.');
  }
  const headers = headerRecord.map((cell) => cell.trim());
  if (headers.length > IMPORT_LIMITS.maxColumns) {
    throw new CsvFileError('too_many_columns', `The file has ${headers.length} columns; the limit is ${IMPORT_LIMITS.maxColumns}.`);
  }
  const blank = headers.findIndex((h) => h === '');
  if (blank !== -1) {
    throw new CsvFileError('blank_header', `Column ${blank + 1} has no heading. Every column needs a heading.`, { column: blank + 1 });
  }
  const seen = new Map<string, number>();
  for (const [index, header] of headers.entries()) {
    const key = header.toLowerCase();
    if (seen.has(key)) {
      throw new CsvFileError('duplicate_header', `The heading “${header}” appears more than once.`, { columns: [seen.get(key)! + 1, index + 1] });
    }
    seen.set(key, index);
  }
  if (dataRecords.length > IMPORT_LIMITS.maxRows) {
    throw new CsvFileError('too_many_rows', `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString('en-GB')} data rows. Split it into smaller files.`);
  }

  const rows = dataRecords.map((values, index) => ({ rowNumber: index + 2, values }));
  if (rows.every((row) => row.values.every((cell) => cell.trim() === ''))) {
    throw new CsvFileError('no_data_rows', 'The file has headings but no data rows.');
  }
  return { sha256: sha256Hex(text), sizeBytes: bytes.byteLength, headers, rows };
}
