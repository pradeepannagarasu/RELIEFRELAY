import { InvestigationOutputSchema } from '@shared/domain/investigationSchema';
import {
  BASIS_ORIGINS,
  CATEGORY_SUPPORTING_STATUSES,
  STEPS_REQUIRING_AUTHORISATION,
  type EvidenceItem,
  type EvidencePack,
  type EvidenceValue,
  type InvestigationOutput,
  type InvestigationResult,
  type ValidationIssue,
} from '@shared/domain/investigation';
import { PAYOUT_ITEM_STATUSES, type PayoutItemStatus } from '@shared/domain/paypal';

/**
 * Deterministic checks applied to every model response before anything is stored or shown.
 *
 * What this establishes: every factual statement cites evidence that exists, quotes values that match that
 * evidence, relies on the right kind of source, and contains no identifier, status, date, amount or day count
 * that is absent from the evidence. It also enforces structural reasoning rules (facts are single, non-causal
 * observations; explanations stay hedged; conflicts and gaps are acknowledged) and the content policy.
 *
 * What it cannot establish: that the reasoning is correct. A response can pass every check and still draw a
 * poor inference from real evidence. The checks are fail-closed: any issue rejects the whole response.
 */

export type ValidationOutcome = { ok: true; result: InvestigationResult } | { ok: false; issues: ValidationIssue[] };

const STATUS_SET = new Set<string>(PAYOUT_ITEM_STATUSES);

/* ---------- Language rules ---------- */

const CAUSAL_ANY =
  /\b(because|caused|causing|cause of|due to|as a result|result(?:ed|s)? (?:in|from)|led to|leads to|owing to|the reason (?:is|was|for)|explains? why|therefore|thus|hence|consequently|which means|this means|so the)\b/i;
const CAUSAL_ASSERTION =
  /\b(caused by|the (?:root )?cause (?:is|was)|is the cause|was the cause|is due to|was due to|(?:failed|returned|blocked|unclaimed|held|reversed|refunded|happened|occurred) (?:because|due to)|as a result of|led to|resulted in|the reason (?:is|was))\b/i;
const INFERENCE = /\b(likely|unlikely|probably|possibly|perhaps|maybe|may|might|could|suggests?|suggesting|indicat(?:es|ed|ing)|appears?|seems?|must have|presumably|implies|implying)\b/i;
const CERTAINTY =
  /\b(definitely|certainly|clearly|undoubtedly|without doubt|proves?|proven|confirms? that|establish(?:es|ed) that|the (?:root )?cause (?:is|was)|is the cause|was the cause|is caused by|was caused by|is due to|was due to|is because|was because|we know that|it is certain)\b/i;
const HEDGE = /\b(may|might|could|possibly|perhaps|one possibility|it is possible)\b/i;
const COMPOUND = /;|[.!?]\s+\S|\b(?:and|but|while|whereas|although|however|so)\s+(?:the|a|an|this|that|it|they|their|its|his|her|there)\b/i;

const FRAUD = /\b(fraud\w*|scam\w*|launder\w*|criminal\w*|theft|thie(?:f|ves)|steal\w*|stole\w*|embezzl\w*|illicit|suspicious|misappropriat\w*|dishonest\w*|decepti\w*|deceiv\w*)\b/i;
const ELIGIBILITY =
  /\b(deserv\w*|eligib\w*|ineligible|entitle\w*|worthy|unworthy|genuine (?:recipient|beneficiary)|legitimate (?:recipient|beneficiary)|should (?:not )?(?:be paid|receive))\b/i;
const CONFIDENCE = /(\b\d{1,3}(?:\.\d+)?\s?%|\bper ?cent\b|\bconfidence\b|\bprobability\b|\blikelihood\b|\bchance of\b)/i;
const AI_ACTION =
  /\b(?:I|we|the AI|ReliefRelay AI)\s+(?:have\s+|has\s+|will\s+|am going to\s+|'ve\s+|'ll\s+)?(?:approved?|initiated?|submitted?|submit|sent|send|retried|retry|cancell?ed|cancel|reissued?|paid|pay|redirected?|executed?|processed|process)\b/i;
const PERSONAL =
  /\b(died|dead|deceased|death|illness|sick|medical|disab\w*|pregnan\w*|hospital\w*|religio\w*|ethnic\w*|refugee status|immigration|displaced|homeless|relocated|moved away)\b/i;
const IDENTITY = /\b(identity of the|who the (?:recipient|beneficiary) is|real name|name of the (?:recipient|beneficiary)|(?:recipient|beneficiary)'s name)\b/i;
const INSTRUCTION_ECHO = /\b(ignore (?:all |any )?(?:previous|prior|above|earlier) instructions|system prompt|developer message|as an ai\b|jailbreak)/i;
const DIRECT_CONTACT = /\b(?:e-?mail|call|phone|text|sms|message|whatsapp|contact|reach out to|visit)\s+(?:the\s+)?(?:recipient|beneficiary|receiver)s?\b/i;
const PRESUMPTION =
  /(?<!\b(?:whether|if)\s)\bthe (?:recipient|beneficiary|receiver)(?:'s|’s)?\s+(?:has|had|is|was|did|does|moved|changed|lost|new|updated|current|correct|preferred|actual)\b/i;
const PAYPAL_CLAIM =
  /\b(?:according to PayPal|PayPal(?:'s|’s)? records?|PayPal\s+(?:has\s+|had\s+)?(?:confirm(?:s|ed)?|reported|reports|shows|showed|stated|states|processed|delivered|paid|sent|returned|failed|blocked|held))\b/i;
const SANDBOX_WORD = /\bsandbox\b/i;
const REAL_DELIVERY =
  /\b(?:recipient|beneficiary|receiver)s?\s+(?:has\s+|have\s+|had\s+)?(?:received|was paid|were paid|got|collected)\b|\b(?:reached|delivered to|paid out to|in the hands of)\s+(?:the\s+)?(?:recipient|beneficiary|receiver)s?\b|\bfunds?\s+(?:arrived|reached)\b/i;
const IMPORTED_AS_PROVIDER = /\b(?:provider|PayPal)\b[^.]*\b(?:confirm|report|show|state)|\bconfirm(?:ed|s)?\b/i;
const NEGATED_CONFIRMATION = /\b(?:not|never|un)\s?(?:been\s+|yet\s+)?confirmed\b.*$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(?:\+|\b00)\d[\d\s().-]{7,}\d/;

/* ---------- Grounding tokens ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, 'gi');
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/g;
const STATUS_UPPER = /\b(SUCCESS|FAILED|PENDING|UNCLAIMED|RETURNED|ONHOLD|BLOCKED|REFUNDED|REVERSED)\b/g;
const ERROR_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const IDENT = /\b(?=[A-Za-z0-9._-]*\d)(?=[A-Za-z0-9._-]*[A-Za-z])[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+\b/g;
const IDENT_EXEMPT = /^\d+-(?:day|days|hour|hours|week|weeks|month|months|year|years)$/i;
const AMOUNT_PREFIX = /(?:\b(USD|EUR|GBP)\s?|([$€£]))\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const AMOUNT_SUFFIX = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(USD|EUR|GBP)\b/g;
const DAY_COUNT = /\b(\d+)\s?-?\s?days?\b/gi;
const OTHER_DURATION = /\b(\d+)\s?-?\s?(hours?|weeks?|months?|years?)\b/gi;
const STATUS_WORDS: [RegExp, PayoutItemStatus][] = [
  [/\bdelivered\b/i, 'SUCCESS'],
  [/\bfailed\b/i, 'FAILED'],
  [/\bpending\b/i, 'PENDING'],
  [/\bunclaimed\b/i, 'UNCLAIMED'],
  [/\breturned\b/i, 'RETURNED'],
  [/\bon hold\b/i, 'ONHOLD'],
  [/\bblocked\b/i, 'BLOCKED'],
  [/\brefunded\b/i, 'REFUNDED'],
  [/\breversed\b/i, 'REVERSED'],
];
const SYMBOL_CURRENCY: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

type Token = { kind: 'status' | 'error' | 'ident' | 'date' | 'amount' | 'days' | 'duration'; value: string };

const pad = (n: number) => String(n).padStart(2, '0');
const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const cents = (whole: string, fraction: string | undefined) => Number(whole.replace(/,/g, '')) * 100 + Number((fraction ?? '0').padEnd(2, '0'));
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?/g;

/** Written dates removed, so a month such as “May” is not read as a hedge. */
const withoutDates = (text: string) => text.replace(DAY_MONTH_YEAR, ' ').replace(MONTH_DAY_YEAR, ' ');

function extractTokens(text: string, withStatusWords = false): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(STATUS_UPPER)) tokens.push({ kind: 'status', value: m[1]! });
  if (withStatusWords) {
    const cleaned = text.replace(/\b(?:not|un)\s?delivered\b/gi, ' ');
    for (const [pattern, s] of STATUS_WORDS) if (pattern.test(cleaned)) tokens.push({ kind: 'status', value: s });
  }
  for (const m of text.matchAll(ERROR_TOKEN)) if (!STATUS_SET.has(m[0])) tokens.push({ kind: 'error', value: m[0] });
  for (const m of text.replace(ISO_DATE_TIME, ' ').matchAll(IDENT)) {
    if (IDENT_EXEMPT.test(m[0])) continue;
    tokens.push({ kind: 'ident', value: m[0].toLowerCase() });
  }
  for (const m of text.matchAll(ISO_DATE)) tokens.push({ kind: 'date', value: `${m[1]}-${m[2]}-${m[3]}` });
  for (const m of text.matchAll(DAY_MONTH_YEAR)) tokens.push({ kind: 'date', value: `${m[3]}-${pad(monthIndex(m[2]!))}-${pad(Number(m[1]))}` });
  for (const m of text.matchAll(MONTH_DAY_YEAR)) tokens.push({ kind: 'date', value: `${m[3]}-${pad(monthIndex(m[1]!))}-${pad(Number(m[2]))}` });
  for (const m of text.matchAll(AMOUNT_PREFIX)) {
    const currency = m[1] ?? SYMBOL_CURRENCY[m[2] ?? ''] ?? '';
    tokens.push({ kind: 'amount', value: `${currency}:${cents(m[3]!, m[4])}` });
  }
  for (const m of text.matchAll(AMOUNT_SUFFIX)) tokens.push({ kind: 'amount', value: `${m[3]}:${cents(m[1]!, m[2])}` });
  for (const m of text.matchAll(DAY_COUNT)) tokens.push({ kind: 'days', value: String(Number(m[1])) });
  for (const m of text.matchAll(OTHER_DURATION)) tokens.push({ kind: 'duration', value: `${Number(m[1])} ${m[2]!.toLowerCase()}` });
  return tokens;
}

/* ---------- Evidence index ---------- */

interface EvidenceIndex {
  items: Map<string, EvidenceItem>;
  literals: Map<Token['kind'], Set<string>>;
}

function valueStrings(value: EvidenceValue): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

/** Tokens a field value can vouch for: the value itself plus anything recognisable inside it. */
function tokensOfValue(item: EvidenceItem, field: string): Token[] {
  const value = item.fields[field];
  if (value === undefined || value === null) return [];
  const tokens: Token[] = [];
  for (const s of valueStrings(value)) {
    tokens.push(...extractTokens(s, true));
    if (STATUS_SET.has(s)) tokens.push({ kind: 'status', value: s });
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) tokens.push({ kind: 'ident', value: s.toLowerCase() }, { kind: 'error', value: s });
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) tokens.push({ kind: 'date', value: s.slice(0, 10) });
  }
  if (field === 'amount' || field === 'duplicateAmount') {
    const currency = String(item.fields[field === 'amount' ? 'currency' : 'duplicateCurrency'] ?? '');
    const [whole, fraction] = String(value).split('.');
    tokens.push({ kind: 'amount', value: `${currency}:${cents(whole!, fraction)}` }, { kind: 'amount', value: `:${cents(whole!, fraction)}` });
  }
  if (item.kind === 'derived_value' && item.fields.unit === 'days' && field === 'value') tokens.push({ kind: 'days', value: String(value) });
  if (item.kind === 'reference_rule' && typeof item.fields.days === 'number') tokens.push({ kind: 'days', value: String(item.fields.days) });
  return tokens;
}

function indexEvidence(pack: EvidencePack): EvidenceIndex {
  const items = new Map(pack.evidence.map((e) => [e.id, e]));
  const literals = new Map<Token['kind'], Set<string>>();
  const put = (t: Token) => {
    if (!literals.has(t.kind)) literals.set(t.kind, new Set());
    literals.get(t.kind)!.add(t.value);
  };
  for (const item of pack.evidence) {
    put({ kind: 'ident', value: item.id.toLowerCase() });
    for (const field of Object.keys(item.fields)) tokensOfValue(item, field).forEach(put);
  }
  // An amount written without a currency still has to match a recorded amount.
  for (const value of [...(literals.get('amount') ?? [])]) put({ kind: 'amount', value: `:${value.split(':')[1]}` });
  return { items, literals };
}

const tokenKey = (t: Token) => `${t.kind}|${t.value}`;
const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Whether a value quoted by the model matches the actual field value. */
function valueMatches(actual: EvidenceValue | undefined, quoted: string): boolean {
  if (actual === undefined) return false;
  const q = normalise(quoted);
  if (actual === null) return q === 'null' || q === 'none';
  if (Array.isArray(actual)) return actual.some((a) => normalise(a) === q) || normalise(actual.join(', ')) === q;
  if (typeof actual === 'boolean' || typeof actual === 'number') {
    if (normalise(String(actual)) === q) return true;
    const n = Number(q.replace(/[,$€£]|usd|eur|gbp/g, '').trim());
    return typeof actual === 'number' && q !== '' && !Number.isNaN(n) && n === actual;
  }
  const a = normalise(actual);
  if (a === q) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(a) && q.length >= 10 && a.startsWith(q)) return true;
  if (/^\d+(\.\d+)?$/.test(a)) {
    const n = Number(q.replace(/[,$€£]|usd|eur|gbp/g, '').trim());
    return !Number.isNaN(n) && n === Number(a);
  }
  return a.length > 40 && q.length >= 3 && a.includes(q);
}

/* ---------- Validation ---------- */

export function validateInvestigationOutput(raw: unknown, pack: EvidencePack): ValidationOutcome {
  const parsed = InvestigationOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ code: 'schema', path: i.path.join('.') || '(root)', message: i.message })),
    };
  }
  const output: InvestigationOutput = parsed.data;
  const index = indexEvidence(pack);
  const issues: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });

  /* Identifiers and cross-references. */
  const ids = [...output.known.map((k) => k.id), ...output.unknowns.map((u) => u.id), ...output.possibilities.map((p) => p.id), ...output.nextSteps.map((s) => s.id)];
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) issue('duplicate_id', '(root)', `Item IDs must be unique: ${[...new Set(duplicates)].join(', ')}.`);
  const unknownIds = new Set(output.unknowns.map((u) => u.id));
  const referable = new Set([...output.known.map((k) => k.id), ...unknownIds, ...output.possibilities.map((p) => p.id)]);

  const checkEvidenceIds = (list: string[], path: string) => {
    list.forEach((id, i) => {
      if (!index.items.has(id)) issue('unknown_evidence', `${path}[${i}]`, `Evidence ${id} does not exist in the evidence pack.`);
    });
  };
  const checkCitation = (c: { evidenceId: string; field: string; value: string }, path: string): void => {
    const item = index.items.get(c.evidenceId);
    if (!item) issue('unknown_evidence', `${path}.evidenceId`, `Evidence ${c.evidenceId} does not exist in the evidence pack.`);
    else if (!(c.field in item.fields)) issue('unknown_field', `${path}.field`, `Evidence ${c.evidenceId} has no field ${c.field}.`);
    else if (!valueMatches(item.fields[c.field], c.value)) issue('cited_value_mismatch', `${path}.value`, `The quoted value does not match ${c.evidenceId}.${c.field}.`);
  };

  /* Known facts: single, non-causal observations of one kind of source, every value covered by a citation. */
  output.known.forEach((k, i) => {
    const path = `known[${i}]`;
    checkEvidenceIds(k.evidenceIds, `${path}.evidenceIds`);
    k.citedValues.forEach((c, j) => {
      checkCitation(c, `${path}.citedValues[${j}]`);
      if (!k.evidenceIds.includes(c.evidenceId)) issue('citation_not_listed', `${path}.citedValues[${j}]`, 'A cited value must come from one of the listed evidence items.');
    });
    for (const id of k.evidenceIds) {
      if (!k.citedValues.some((c) => c.evidenceId === id)) issue('evidence_without_value', `${path}.evidenceIds`, `Evidence ${id} is listed but no value from it is quoted.`);
      const item = index.items.get(id);
      if (item && !BASIS_ORIGINS[k.basis].includes(item.origin)) {
        issue('basis_mismatch', `${path}.basis`, `A ${k.basis} statement cannot rely on ${item.origin} evidence (${id}).`);
      }
    }
    if (CAUSAL_ANY.test(k.statement)) issue('causal_claim_in_fact', `${path}.statement`, 'Known facts must state what the records show, not why it happened.');
    if (INFERENCE.test(withoutDates(k.statement))) issue('inference_in_fact', `${path}.statement`, 'Known facts must not contain inferences or hedged claims.');
    if (COMPOUND.test(k.statement)) issue('compound_fact', `${path}.statement`, 'Each known fact must make a single claim.');
    if (
      PAYPAL_CLAIM.test(k.statement) &&
      k.evidenceIds.length > 0 &&
      k.evidenceIds.every((id) => index.items.get(id)?.origin !== 'provider_sandbox') &&
      k.evidenceIds.some((id) => index.items.get(id)?.origin === 'provider_simulation')
    ) {
      issue('simulation_presented_as_paypal', `${path}.statement`, 'A fact based only on simulated provider records must not be presented as a PayPal record.');
    }
    if (k.basis === 'imported_record' && IMPORTED_AS_PROVIDER.test(k.statement.replace(NEGATED_CONFIRMATION, ''))) {
      issue('imported_presented_as_confirmed', `${path}.statement`, 'An imported record must not be described as provider-confirmed.');
    }
    const covered = new Set(
      k.citedValues.flatMap((c) => {
        const item = index.items.get(c.evidenceId);
        return item ? tokensOfValue(item, c.field).map(tokenKey) : [];
      }),
    );
    for (const t of extractTokens(k.statement, true)) {
      if (!covered.has(tokenKey(t))) issue('unsupported_value', `${path}.statement`, `The statement mentions a ${t.kind} that none of its quoted values support.`);
    }
  });

  /* Unknowns. */
  output.unknowns.forEach((u, i) => {
    checkEvidenceIds(u.evidenceIds, `unknowns[${i}].evidenceIds`);
    if (u.kind === 'conflicting_records') {
      const citesConflict = u.evidenceIds.some((id) => index.items.get(id)?.kind === 'conflict');
      if (!citesConflict && u.evidenceIds.length < 2) issue('conflict_without_evidence', `unknowns[${i}].evidenceIds`, 'A conflict must cite the records that disagree.');
    }
  });

  /* Possibilities: hedged, supported by compatible evidence, tied to what would resolve them. */
  output.possibilities.forEach((p, i) => {
    const path = `possibilities[${i}]`;
    if (!HEDGE.test(withoutDates(p.explanation))) issue('possibility_not_hedged', `${path}.explanation`, 'A possible explanation must be worded as a possibility.');
    if (CERTAINTY.test(p.explanation)) issue('possibility_presented_as_confirmed', `${path}.explanation`, 'A possible explanation must not be presented as a confirmed cause.');
    p.supports.forEach((c, j) => checkCitation(c, `${path}.supports[${j}]`));
    p.weakens.forEach((c, j) => checkCitation(c, `${path}.weakens[${j}]`));
    const supportIds = new Set(p.supports.map((c) => `${c.evidenceId}.${c.field}`));
    p.weakens.forEach((c, j) => {
      if (supportIds.has(`${c.evidenceId}.${c.field}`)) issue('contradictory_citation', `${path}.weakens[${j}]`, 'The same value cannot both support and weaken an explanation.');
    });
    p.wouldBeResolvedBy.forEach((id, j) => {
      if (!unknownIds.has(id)) issue('unknown_reference', `${path}.wouldBeResolvedBy[${j}]`, `${id} is not one of the listed unknowns.`);
    });
    const allowed = CATEGORY_SUPPORTING_STATUSES[p.category];
    p.supports.forEach((c, j) => {
      const item = index.items.get(c.evidenceId);
      const value = item?.fields[c.field];
      if (allowed && typeof value === 'string' && STATUS_SET.has(value) && !allowed.includes(value as PayoutItemStatus)) {
        issue('support_contradicts_explanation', `${path}.supports[${j}]`, `Status ${value} cannot support the explanation category ${p.category}.`);
      }
    });
    const supportItems = p.supports.map((c) => index.items.get(c.evidenceId)).filter((e): e is EvidenceItem => e !== undefined);
    if (p.category === 'duplicate_entry' && !supportItems.some((e) => e.kind === 'finding' && e.fields.code === 'possible_duplicate_payment')) {
      issue('support_contradicts_explanation', `${path}.supports`, 'A duplicate explanation needs a possible duplicate finding as support.');
    }
    if (
      p.category === 'imported_record_out_of_date' &&
      !(supportItems.some((e) => BASIS_ORIGINS.provider_record.includes(e.origin)) && supportItems.some((e) => e.origin === 'imported'))
    ) {
      issue('support_contradicts_explanation', `${path}.supports`, 'An out-of-date imported record can only be suggested when both a provider and an imported record are cited.');
    }
  });

  /* Conflicts and gaps detected by ReliefRelay must be acknowledged; the conclusion must not ignore a conflict. */
  for (const item of pack.evidence) {
    if (item.kind === 'conflict') {
      if (!output.unknowns.some((u) => u.kind === 'conflicting_records' && u.evidenceIds.includes(item.id))) {
        issue('conflict_not_acknowledged', 'unknowns', `Conflict ${item.id} must be listed as a conflicting-records unknown.`);
      }
      if (!output.conclusion.evidenceIds.includes(item.id)) {
        issue('conclusion_ignores_conflict', 'conclusion.evidenceIds', `The conclusion must take conflict ${item.id} into account.`);
      }
    }
    if (item.kind === 'gap' && !output.unknowns.some((u) => u.evidenceIds.includes(item.id))) {
      issue('gap_not_acknowledged', 'unknowns', `Gap ${item.id} must be listed as an unknown.`);
    }
  }
  if (output.possibilities.length === 0 && !output.unknowns.some((u) => u.kind === 'cannot_be_established')) {
    issue('limitation_not_stated', 'unknowns', 'When no explanation is offered, the analysis must state what cannot be established.');
  }

  /* Conclusion. */
  checkEvidenceIds(output.conclusion.evidenceIds, 'conclusion.evidenceIds');
  if (CAUSAL_ASSERTION.test(output.conclusion.summary)) issue('unsupported_causal_claim', 'conclusion.summary', 'The conclusion must not assert a cause.');
  if (CERTAINTY.test(output.conclusion.summary)) issue('possibility_presented_as_confirmed', 'conclusion.summary', 'The conclusion must not present an explanation as confirmed.');

  /* Next steps: grounded in listed items and not built on information the evidence does not contain. */
  const knownById = new Map(output.known.map((k) => [k.id, k]));
  output.nextSteps.forEach((s, i) => {
    const path = `nextSteps[${i}]`;
    s.relatesTo.forEach((id, j) => {
      if (!referable.has(id)) issue('unknown_reference', `${path}.relatesTo[${j}]`, `${id} is not a listed fact, unknown or possibility.`);
    });
    if (CAUSAL_ASSERTION.test(s.action)) issue('unsupported_causal_claim', `${path}.action`, 'A next step must not assert a cause.');
    if (DIRECT_CONTACT.test(s.action)) issue('direct_beneficiary_contact', `${path}.action`, 'Steps must not involve contacting recipients directly.');
    if (s.type === 'request_information_from_programme_team' && !s.informationNeeded) {
      issue('information_not_specified', `${path}.informationNeeded`, 'A request for information must say what is needed.');
    }
    // Judged by where the cited evidence actually comes from, not by the basis the model declared.
    const relatedProviderStatuses: string[] = [];
    for (const c of s.relatesTo.flatMap((id) => knownById.get(id)?.citedValues ?? [])) {
      const item = index.items.get(c.evidenceId);
      const value = item?.fields[c.field];
      if (item && BASIS_ORIGINS.provider_record.includes(item.origin) && typeof value === 'string' && STATUS_SET.has(value)) relatedProviderStatuses.push(value);
    }
    if (s.type === 'propose_reissue' && !relatedProviderStatuses.some((v) => v === 'FAILED' || v === 'RETURNED')) {
      issue('recommendation_without_basis', `${path}.type`, 'A reissue can only be suggested when a related provider record shows FAILED or RETURNED.');
    }
    if (s.type === 'propose_cancellation' && !relatedProviderStatuses.includes('UNCLAIMED')) {
      issue('recommendation_without_basis', `${path}.type`, 'A cancellation can only be suggested when a related provider record shows UNCLAIMED.');
    }
  });

  /* Every text field: policy and grounding. */
  const texts: { path: string; text: string; isQuestion?: boolean }[] = [];
  output.known.forEach((k, i) => texts.push({ path: `known[${i}].statement`, text: k.statement }));
  output.unknowns.forEach((u, i) => texts.push({ path: `unknowns[${i}].question`, text: u.question, isQuestion: true }));
  output.possibilities.forEach((p, i) => {
    texts.push({ path: `possibilities[${i}].explanation`, text: p.explanation });
    p.supports.forEach((c, j) => texts.push({ path: `possibilities[${i}].supports[${j}].reason`, text: c.reason }));
    p.weakens.forEach((c, j) => texts.push({ path: `possibilities[${i}].weakens[${j}].reason`, text: c.reason }));
  });
  output.nextSteps.forEach((s, i) => {
    texts.push({ path: `nextSteps[${i}].action`, text: s.action });
    if (s.informationNeeded) texts.push({ path: `nextSteps[${i}].informationNeeded`, text: s.informationNeeded, isQuestion: true });
  });
  texts.push({ path: 'conclusion.summary', text: output.conclusion.summary }, { path: 'conclusion.limitations', text: output.conclusion.limitations });

  const sandbox = pack.evidence.some((e) => e.origin === 'provider_sandbox');
  for (const { path, text, isQuestion } of texts) {
    if (FRAUD.test(text)) issue('policy_fraud_language', path, 'The analysis must not suggest fraud or wrongdoing.');
    if (ELIGIBILITY.test(text)) issue('policy_eligibility_judgement', path, 'The analysis must not judge whether anyone should receive aid.');
    if (CONFIDENCE.test(text)) issue('policy_confidence_score', path, 'The analysis must not give confidence scores, probabilities or percentages.');
    if (AI_ACTION.test(text)) issue('policy_action_claim', path, 'The analysis must not claim to take or have taken any action.');
    if (PERSONAL.test(text)) issue('policy_personal_circumstances', path, 'The analysis must not speculate about personal circumstances.');
    if (IDENTITY.test(text)) issue('policy_identity_inference', path, 'The analysis must not infer anyone’s identity.');
    if (EMAIL.test(text) || PHONE.test(text)) issue('policy_contact_details', path, 'The analysis must not contain contact details.');
    if (INSTRUCTION_ECHO.test(text)) issue('instruction_echo', path, 'The analysis must not discuss or follow instructions found in data.');
    if (!isQuestion && PRESUMPTION.test(text)) issue('assumes_unstated_information', path, 'The analysis states something about the recipient that the evidence does not contain.');
    if (!sandbox && PAYPAL_CLAIM.test(text)) issue('simulation_presented_as_paypal', path, 'Simulated provider records must not be presented as PayPal records.');
    if (sandbox && PAYPAL_CLAIM.test(text) && !SANDBOX_WORD.test(text)) {
      issue('sandbox_not_qualified', path, 'PayPal Sandbox records must be described as Sandbox records, never as PayPal records without qualification.');
    }
    if (sandbox && REAL_DELIVERY.test(text)) {
      issue('sandbox_presented_as_real_delivery', path, 'PayPal Sandbox uses test money: the analysis must not say a payout reached or was received by a recipient.');
    }
    for (const t of extractTokens(text)) {
      if (t.kind === 'duration') {
        issue('ungrounded_duration', path, 'Durations other than day counts calculated by ReliefRelay are not allowed.');
        continue;
      }
      if (!index.literals.get(t.kind)?.has(t.value)) issue(`ungrounded_${t.kind}`, path, `The text contains a ${t.kind} that does not appear in the evidence.`);
    }
  }

  if (issues.length > 0) {
    const seen = new Set<string>();
    return { ok: false, issues: issues.filter((i) => (seen.has(`${i.code}|${i.path}`) ? false : (seen.add(`${i.code}|${i.path}`), true))).slice(0, 40) };
  }
  return {
    ok: true,
    result: {
      ...output,
      nextSteps: output.nextSteps.map((s) => ({ ...s, requiresHumanAuthorisation: STEPS_REQUIRING_AUTHORISATION.includes(s.type) })),
    },
  };
}
