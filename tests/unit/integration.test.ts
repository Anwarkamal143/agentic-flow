/**
 * The Integration Task (ARCHITECTURE §14, GLOSSARY, ADR-0034): the order the
 * approved Task Branches merge into the Integration Branch, the definition the
 * factory gives the Integration Task from its Repository's Plan Tasks, and the
 * `feature` Recipe versions. Pure; tested through `@factory/domain`.
 */
import {
  featureRecipe,
  FEATURE_RECIPE,
  integrationDefinition,
  integrationOrder,
  type TaskDefinition,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('integrationOrder', () => {
  it('merges a Task after everything it depends on', () => {
    expect(
      integrationOrder([
        { key: 'd', dependsOn: ['b', 'c'] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'a', dependsOn: [] },
        { key: 'c', dependsOn: ['a'] },
      ]),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('breaks ties by Task key, not by Plan order', () => {
    expect(
      integrationOrder([
        { key: 'zeta', dependsOn: [] },
        { key: 'alpha', dependsOn: [] },
        { key: 'mid', dependsOn: ['zeta'] },
      ]),
    ).toEqual(['alpha', 'zeta', 'mid']);
  });

  it('takes the smallest ready key at each step, even one that became ready later', () => {
    // y and z are ready first; once y is merged, b is ready too, and b < z.
    expect(
      integrationOrder([
        { key: 'z', dependsOn: [] },
        { key: 'y', dependsOn: [] },
        { key: 'b', dependsOn: ['y'] },
      ]),
    ).toEqual(['y', 'b', 'z']);
  });

  it('ignores dependencies on Tasks outside the set (another Repository)', () => {
    expect(
      integrationOrder([
        { key: 'b', dependsOn: ['elsewhere'] },
        { key: 'a', dependsOn: [] },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('refuses a cycle', () => {
    expect(() =>
      integrationOrder([
        { key: 'a', dependsOn: ['b'] },
        { key: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(/cycle/);
  });
});

function definition(over: Partial<TaskDefinition>): TaskDefinition {
  return {
    objective: 'do it',
    role: 'developer',
    risk: 'low',
    scope: { writable: ['src/**'], forbidden: [], readHints: [] },
    dependsOn: [],
    acceptance: [],
    verification: [{ key: 'test', command: 'pnpm test', required: true, criteria: [] }],
    ...over,
  };
}

describe('integrationDefinition', () => {
  it("takes the union of the Plan Tasks' writable globs and covered criteria", () => {
    const d = integrationDefinition([
      {
        key: 'a',
        definition: definition({
          scope: { writable: ['src/a/**', 'docs/**'], forbidden: ['package.json'], readHints: [] },
          acceptance: ['AC-01'],
        }),
      },
      {
        key: 'b',
        definition: definition({
          scope: { writable: ['src/b/**', 'docs/**'], forbidden: [], readHints: [] },
          acceptance: ['AC-02', 'AC-01'],
          risk: 'high',
        }),
      },
    ]);
    expect(d.scope.writable).toEqual(['src/a/**', 'docs/**', 'src/b/**']);
    // A glob one Task forbids may be another's to write: the union forbids nothing (ADR-0034).
    expect(d.scope.forbidden).toEqual([]);
    expect(d.acceptance).toEqual(['AC-01', 'AC-02']);
    expect(d.risk).toBe('high');
    expect(d.dependsOn).toEqual([]);
    expect(d.objective).toMatch(/a, b/);
  });

  it('runs a command the Tasks share once, verifying every criterion any of them named', () => {
    const d = integrationDefinition([
      {
        key: 'a',
        definition: definition({
          verification: [
            { key: 'test', command: 'pnpm test', required: false, criteria: ['AC-01'] },
          ],
        }),
      },
      {
        key: 'b',
        definition: definition({
          verification: [
            { key: 'unit', command: 'pnpm test', required: true, criteria: ['AC-02', 'AC-01'] },
            { key: 'lint', command: 'pnpm lint', required: true, criteria: [] },
          ],
        }),
      },
    ]);
    expect(d.verification).toEqual([
      { key: 'test', command: 'pnpm test', required: true, criteria: ['AC-01', 'AC-02'] },
      { key: 'lint', command: 'pnpm lint', required: true, criteria: [] },
    ]);
  });

  it('keeps verification keys unique when different commands share one', () => {
    const d = integrationDefinition([
      { key: 'a', definition: definition({}) },
      {
        key: 'b',
        definition: definition({
          verification: [{ key: 'test', command: 'pnpm vitest b', required: true, criteria: [] }],
        }),
      },
    ]);
    expect(d.verification.map((v) => [v.key, v.command])).toEqual([
      ['test', 'pnpm test'],
      ['test-2', 'pnpm vitest b'],
    ]);
  });

  it('needs at least one Plan Task', () => {
    expect(() => integrationDefinition([])).toThrow(/at least one/);
  });
});

describe('the feature Recipe', () => {
  it('is version 3, with integration between execution and closure', () => {
    expect(FEATURE_RECIPE.recipeVersion).toBe(3);
    expect(FEATURE_RECIPE.stages.map((s) => s.id)).toEqual([
      'intake',
      'triage',
      'discovery',
      'specification',
      'planning',
      'plan_approval',
      'execution',
      'integration',
      'closure',
    ]);
  });

  it('keeps version 2 as it was, without integration', () => {
    expect(featureRecipe(2).stages.map((s) => s.id)).not.toContain('integration');
    expect(featureRecipe(2).stages.at(-1)?.id).toBe('closure');
    expect(featureRecipe(3)).toEqual(FEATURE_RECIPE);
  });
});
