import { z } from 'zod';
import { NEXT_STEP_TYPES, POSSIBILITY_CATEGORIES, STATEMENT_BASES, UNKNOWN_KINDS } from './investigation';

/** Zod schema for model output and the strict JSON Schema derived from it. Server-side only. */

const EVIDENCE_ID = /^[A-Z]{2,8}[0-9]{1,3}$/;
const evidenceId = z.string().regex(EVIDENCE_ID);
const text = (max: number) => z.string().min(1).max(max);

const CitedValue = z.strictObject({
  evidenceId,
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
  value: text(120),
});

const Citation = z.strictObject({
  evidenceId,
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
  value: text(120),
  reason: text(300),
});

export const InvestigationOutputSchema = z.strictObject({
  known: z
    .array(
      z.strictObject({
        id: z.string().regex(/^K[0-9]{1,2}$/),
        statement: text(300),
        basis: z.enum(STATEMENT_BASES),
        evidenceIds: z.array(evidenceId).min(1).max(6),
        citedValues: z.array(CitedValue).min(1).max(6),
      }),
    )
    .min(1)
    .max(12),
  unknowns: z
    .array(
      z.strictObject({
        id: z.string().regex(/^U[0-9]{1,2}$/),
        kind: z.enum(UNKNOWN_KINDS),
        question: text(300),
        evidenceIds: z.array(evidenceId).max(6),
      }),
    )
    .max(8),
  possibilities: z
    .array(
      z.strictObject({
        id: z.string().regex(/^P[0-9]{1,2}$/),
        category: z.enum(POSSIBILITY_CATEGORIES),
        explanation: text(500),
        supports: z.array(Citation).min(1).max(5),
        weakens: z.array(Citation).max(5),
        wouldBeResolvedBy: z.array(z.string().regex(/^U[0-9]{1,2}$/)).min(1).max(4),
      }),
    )
    .max(4),
  nextSteps: z
    .array(
      z.strictObject({
        id: z.string().regex(/^S[0-9]{1,2}$/),
        type: z.enum(NEXT_STEP_TYPES),
        action: text(300),
        relatesTo: z.array(z.string().regex(/^[KUP][0-9]{1,2}$/)).min(1).max(5),
        informationNeeded: z.string().max(300).nullable(),
      }),
    )
    .min(1)
    .max(5),
  conclusion: z.strictObject({
    summary: text(800),
    evidenceIds: z.array(evidenceId).min(1).max(12),
    limitations: text(500),
  }),
});
export type InvestigationOutput = z.infer<typeof InvestigationOutputSchema>;

type JsonSchema = { [key: string]: unknown };

/** Keywords OpenAI Structured Outputs does not accept in strict mode. Length limits stay enforced by Zod. */
const UNSUPPORTED_KEYWORDS = new Set(['$schema', 'minLength', 'maxLength', 'allOf', 'not', 'if', 'then', 'else', 'default']);

function sanitise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitise);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value as JsonSchema).map(([k, v]) => [k, sanitise(v)])) : sanitise(value);
  }
  return out;
}

/**
 * The strict JSON Schema sent to the Responses API, generated from the Zod schema so the two cannot drift.
 * Every object has additionalProperties: false and lists all of its properties as required.
 */
export function investigationJsonSchema(): JsonSchema {
  return sanitise(z.toJSONSchema(InvestigationOutputSchema, { target: 'draft-2020-12', io: 'output' })) as JsonSchema;
}
