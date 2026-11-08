/**
 * Fake Harness scripts shared by the scenarios. The proposals take the `tiny-ts`
 * fixture to one Task, `add-sum`; its execution response adds `sum()` and
 * commits it. Verification commands are plain shell checks, so no dependency
 * install is needed in the Worktree.
 */
import { parse, stringify } from 'yaml';

export const SUM_SOURCE =
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n\n' +
  '/** Sums two numbers. */\nexport function sum(a: number, b: number): number {\n  return a + b;\n}\n';

/** A Fake Harness script whose every proposal is valid and whose Task succeeds. */
export const VALID_SCRIPT = `
version: 1
stages:
  triage:
    - output:
        summary: Add a sum() helper to the math module.
        type: feature
        risk: low
  discovery:
    - output:
        summary: math.ts exports add(); tests live in test/math.test.ts.
        files:
          - path: src/math.ts
            reason: the module to extend
          - path: test/math.test.ts
            reason: where the new test goes
  specification:
    - output:
        problem: There is no way to sum two numbers.
        objective: Export sum(a, b) from src/math.ts.
        scope: [src/math.ts, test/math.test.ts]
        outOfScope: [other modules]
        requirements:
          - code: FR-01
            text: sum(a, b) returns a + b.
        acceptanceCriteria:
          - code: AC-01
            text: sum(2, 3) returns 5.
            mandatory: true
            verification: the test command
          - code: AC-02
            text: sum is documented with a JSDoc comment.
            mandatory: false
            verification: review
        edgeCases: [negative numbers]
        securityConsiderations: []
        definitionOfDone: [AC-01 passes under the factory's own test run]
  planning:
    - output:
        tasks:
          - key: add-sum
            title: Add sum() to math.ts
            objective: Export sum(a, b) and test it.
            repository: tiny-ts
            role: developer
            risk: low
            scope:
              writable: [src/math.ts, test/**]
              forbidden: [package.json, .github/**]
            dependsOn: []
            acceptance: [AC-01]
            verification:
              - key: test
                command: grep -q 'export function sum' src/math.ts
                required: true
                criteria: [AC-01]
              - key: typecheck
                command: test -f src/math.ts && echo typecheck ok
                required: true
tasks:
  add-sum:
    - steps:
        - write:
            path: src/math.ts
            content: ${JSON.stringify(SUM_SOURCE)}
        - commit: Add sum() to math.ts
      result:
        status: done
        summary: Added sum() to src/math.ts.
        commits: []
        criteria:
          - code: AC-01
            claim: met
            how: sum(2, 3) returns 5
`;

interface Script {
  stages: Record<string, unknown[]>;
  tasks?: Record<string, unknown[]>;
}

/** The valid script with some Stages' (and Tasks') responses replaced. */
export function scriptWith(stages: Record<string, unknown[]>, tasks?: Record<string, unknown[]>) {
  const script = parse(VALID_SCRIPT) as Script;
  return stringify({
    ...script,
    stages: { ...script.stages, ...stages },
    tasks: { ...script.tasks, ...tasks },
  });
}

/** The valid response of a Stage, as an object to change. */
export function validOutput(stage: string): Record<string, unknown> {
  const script = parse(VALID_SCRIPT) as { stages: Record<string, [{ output: object }]> };
  return structuredClone(script.stages[stage]?.[0].output) as Record<string, unknown>;
}

/** The valid `add-sum` execution response, as an object to change. */
export function validTaskResponse(): {
  steps: Record<string, unknown>[];
  result: Record<string, unknown>;
  [key: string]: unknown;
} {
  const script = parse(VALID_SCRIPT) as Script;
  return structuredClone(script.tasks?.['add-sum']?.[0]) as ReturnType<typeof validTaskResponse>;
}
