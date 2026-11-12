import type { InvestigationFailureCode } from '@shared/domain/investigation';

export interface AiRequest {
  /** Fixed, versioned instructions. */
  instructions: string;
  /** The evidence pack exactly as stored with the attempt. */
  evidence: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AiResponse =
  | { ok: true; output: unknown; model: string | null; responseId: string | null; usage: AiUsage }
  | {
      ok: false;
      failure: Exclude<InvestigationFailureCode, 'failed_validation' | 'interrupted'>;
      /** Safe for storage and display: never contains request bodies, prompts, keys or provider error text. */
      detail: string;
      model: string | null;
      responseId: string | null;
      usage: AiUsage;
      retryAfterSeconds?: number;
    };

export interface AiProvider {
  readonly name: 'openai';
  readonly model: string;
  investigate(request: AiRequest): Promise<AiResponse>;
}
