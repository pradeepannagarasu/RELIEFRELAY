import { IMPORT_FIELD_INFO, IMPORT_FIELDS, REQUIRED_IMPORT_FIELDS, type ColumnMapping, type ImportField } from '@shared/domain/imports';

const normaliseHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Suggests a column for each field from common header names. Each column is suggested at most once. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const normalised = headers.map(normaliseHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  for (const field of IMPORT_FIELDS) {
    for (const alias of IMPORT_FIELD_INFO[field].aliases) {
      const index = normalised.findIndex((header, i) => header === normaliseHeader(alias) && !used.has(i));
      if (index !== -1) {
        mapping[field] = index;
        used.add(index);
        break;
      }
    }
  }
  return mapping;
}

export interface MappingProblem {
  field: ImportField | null;
  message: string;
}

export function validateMapping(mapping: ColumnMapping, headerCount: number): MappingProblem[] {
  const problems: MappingProblem[] = [];
  for (const field of REQUIRED_IMPORT_FIELDS) {
    if (mapping[field] === undefined) problems.push({ field, message: `Choose the column that contains ${IMPORT_FIELD_INFO[field].label.toLowerCase()}.` });
  }
  const byColumn = new Map<number, ImportField>();
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column === undefined) continue;
    if (!Number.isInteger(column) || column < 0 || column >= headerCount) {
      problems.push({ field, message: `${IMPORT_FIELD_INFO[field].label} refers to a column that does not exist.` });
      continue;
    }
    const other = byColumn.get(column);
    if (other) {
      problems.push({
        field,
        message: `${IMPORT_FIELD_INFO[field].label} and ${IMPORT_FIELD_INFO[other].label} cannot use the same column.`,
      });
    }
    byColumn.set(column, field);
  }
  return problems;
}
