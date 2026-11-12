import { DEFAULT_OPENAI_MODEL } from '@shared/domain/investigation';
import { loadConfig, loadDotEnv } from '../config/env';
import { createInvestigationService } from '../services/investigationService';
import { createScenario } from '../test-support/investigationFixtures';
import { TEST_NOW } from '../test-support/seededApp';
import { createOpenAiProvider } from './openaiProvider';

/**
 * npm run ai:smoke: a manual, opt-in check against the real OpenAI API.
 *
 * It never runs in tests, builds or at startup. It builds a temporary database from the synthetic demo data set,
 * runs real investigations on three synthetic cases and prints the outcome, token usage and estimated cost.
 * No real beneficiary data exists in that database. The temporary database is deleted afterwards.
 */

const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  [DEFAULT_OPENAI_MODEL]: { input: 2, output: 10 },
};

async function main() {
  loadDotEnv();
  const config = loadConfig({ ...process.env, NODE_ENV: 'development' });
  const { openai } = config;
  if (!openai.apiKey) {
    console.error('OPENAI_API_KEY is not set. Add it to .env to run the live smoke test. Nothing was sent.');
    process.exit(1);
  }
  const show = process.argv.includes('--show');
  console.log(`Live AI smoke test: model ${openai.model}, reasoning effort ${openai.reasoningEffort}, timeout ${openai.timeoutMs} ms.`);
  console.log('Using a temporary database built from the synthetic demo data set only.\n');

  const scenario = await createScenario();
  try {
    const provider = createOpenAiProvider({
      apiKey: openai.apiKey,
      model: openai.model,
      baseUrl: openai.baseUrl,
      timeoutMs: openai.timeoutMs,
      maxOutputTokens: openai.maxOutputTokens,
      reasoningEffort: openai.reasoningEffort,
    });
    const service = createInvestigationService({ db: scenario.temp.db, clock: () => TEST_NOW, provider, dailyLimit: 10, timeoutMs: openai.timeoutMs });
    const cases: [string, string][] = [
      ['Provider-confirmed RETURNED payment', scenario.providerCaseId],
      ['Provider SUCCESS vs imported RETURNED', scenario.conflictCaseId],
      ['Imported FAILED, no provider record', scenario.importedOnlyCaseId],
    ];
    const price = PRICE_PER_MILLION[openai.model];
    let totalCost = 0;
    let succeeded = 0;
    for (const [label, caseId] of cases) {
      const version = (scenario.temp.db.prepare('SELECT version FROM payment_cases WHERE id = ?').get(caseId) as { version: number }).version;
      const detail = await service.run(scenario.ctx, caseId, version);
      const { inputTokens, outputTokens, latencyMs } = detail.usage;
      const cost = price && inputTokens !== null && outputTokens !== null ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
      if (cost !== null) totalCost += cost;
      if (detail.status === 'succeeded') succeeded += 1;
      console.log(`${label}`);
      console.log(`  status:   ${detail.status}${detail.failure ? ` (${detail.failure.code}: ${detail.failure.detail ?? detail.failure.description})` : ''}`);
      console.log(`  model:    ${detail.model}`);
      console.log(`  evidence: ${detail.evidenceCount} items`);
      console.log(`  tokens:   ${inputTokens ?? '?'} in, ${outputTokens ?? '?'} out; ${latencyMs ?? '?'} ms; ${cost === null ? 'cost unknown' : `about $${cost.toFixed(4)}`}`);
      if (detail.validationIssues.length > 0) {
        console.log('  failed checks:');
        for (const issue of detail.validationIssues) console.log(`    - ${issue.code} at ${issue.path}: ${issue.message}`);
      }
      if (detail.result) {
        console.log(`  ${detail.result.known.length} facts, ${detail.result.unknowns.length} unknowns, ${detail.result.possibilities.length} possibilities, ${detail.result.nextSteps.length} next steps`);
        console.log(`  conclusion: ${detail.result.conclusion.summary}`);
        if (show) console.log(JSON.stringify(detail.result, null, 2));
      }
      console.log('');
    }
    console.log(`${succeeded} of ${cases.length} investigations passed every check. Estimated total cost: ${price ? `$${totalCost.toFixed(4)}` : 'unknown for this model'}.`);
    process.exitCode = succeeded === cases.length ? 0 : 2;
  } finally {
    scenario.temp.cleanup();
  }
}

void main();
