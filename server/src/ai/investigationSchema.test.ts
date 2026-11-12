import { describe, expect, it } from 'vitest';
import { NEXT_STEP_TYPES, POSSIBILITY_CATEGORIES, STATEMENT_BASES, UNKNOWN_KINDS } from '@shared/domain/investigation';
import { investigationJsonSchema, InvestigationOutputSchema } from '@shared/domain/investigationSchema';
import { conflictCaseOutput, importedCaseOutput, providerCaseOutput } from '../test-support/aiFixtures';

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (node: Node, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) return node.forEach((child, i) => walk(child, visit, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return;
  visit(node as Node, path);
  for (const [key, value] of Object.entries(node as Node)) walk(value, visit, `${path}.${key}`);
}

describe('structured output schema', () => {
  const schema = investigationJsonSchema();

  it('meets the strict Structured Outputs rules', () => {
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('anyOf');
    let objects = 0;
    let depth = 0;
    walk(schema, (node, path) => {
      for (const keyword of ['allOf', 'not', 'if', 'then', 'else', 'minLength', 'maxLength', '$schema', 'default']) {
        expect(node, `${path} uses ${keyword}`).not.toHaveProperty(keyword);
      }
      if (node.type === 'object') {
        objects += 1;
        expect(node.additionalProperties, path).toBe(false);
        expect([...(node.required as string[])].sort(), path).toEqual(Object.keys(node.properties as Node).sort());
      }
      depth = Math.max(depth, path.split('.properties').length);
    });
    expect(objects).toBeGreaterThan(5);
    expect(depth).toBeLessThanOrEqual(10);
  });

  it('matches the Zod schema it is generated from', () => {
    const props = schema.properties as Record<string, Node>;
    const items = (name: string) => (props[name] as { items: { properties: Record<string, Node> } }).items.properties;
    expect(items('known').basis!.enum).toEqual([...STATEMENT_BASES]);
    expect(items('unknowns').kind!.enum).toEqual([...UNKNOWN_KINDS]);
    expect(items('possibilities').category!.enum).toEqual([...POSSIBILITY_CATEGORIES]);
    expect(items('nextSteps').type!.enum).toEqual([...NEXT_STEP_TYPES]);
    expect(Object.keys(props).sort()).toEqual(Object.keys(InvestigationOutputSchema.shape).sort());
    for (const output of [providerCaseOutput(), conflictCaseOutput(), importedCaseOutput()]) {
      expect(InvestigationOutputSchema.safeParse(output).success).toBe(true);
    }
  });

  it('has no confidence, score or probability fields', () => {
    expect(JSON.stringify(schema)).not.toMatch(/confidence|score|probab|likelihood|percent/i);
  });
});
