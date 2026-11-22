/**
 * The Plan validator's Phase B rules (ARCHITECTURE §7): a Task's `maxAttempts`
 * may only narrow the Effective Configuration, and Tasks that no dependency
 * path orders must not write overlapping paths. Every problem names its rule,
 * so the one re-prompt can carry it back to the planner.
 */
import {
  checkPathScope,
  PlanProposalSchema,
  validatePlan,
  withSensitivePaths,
  type PlanContext,
  type PlanProposal,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

interface TaskOver {
  key: string;
  writable: string[];
  dependsOn?: string[];
  repository?: string;
  maxAttempts?: number;
}

const plan = (...tasks: TaskOver[]): PlanProposal =>
  PlanProposalSchema.parse({
    tasks: tasks.map((t) => ({
      key: t.key,
      title: `Task ${t.key}`,
      objective: 'Change something.',
      repository: t.repository ?? 'app',
      role: 'developer',
      risk: 'low',
      scope: { writable: t.writable },
      dependsOn: t.dependsOn ?? [],
      acceptance: ['AC-01'],
      verification: [{ key: 'test', command: 'true', criteria: ['AC-01'] }],
      ...(t.maxAttempts === undefined ? {} : { maxAttempts: t.maxAttempts }),
    })),
  });

const TRACKED = [
  'src/a/one.ts',
  'src/a/two.ts',
  'src/b/three.ts',
  'docs/readme.md',
  'package.json',
];

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  repositories: [
    { id: 'repo_app', name: 'app' },
    { id: 'repo_web', name: 'web' },
  ],
  criteria: [{ code: 'AC-01', mandatory: true }],
  maxAttempts: 3,
  trackedFiles: new Map([
    ['repo_app', TRACKED],
    ['repo_web', TRACKED],
  ]),
  sensitivePaths: new Map(),
  ...over,
});

const issues = (p: PlanProposal, c: PlanContext = ctx()) => validatePlan(p, c);
const rules = (p: PlanProposal, c?: PlanContext) => issues(p, c).map((i) => i.rule);

describe('validatePlan: overlapping writable paths', () => {
  it('rejects two unordered Tasks whose writable globs overlap, naming the pair and the tracked paths', () => {
    const found = issues(
      plan({ key: 'one', writable: ['src/**'] }, { key: 'two', writable: ['src/a/**'] }),
    );

    expect(found).toEqual([
      {
        rule: 'plan.no_overlapping_writes',
        message: expect.stringContaining('Tasks one and two') as string,
      },
    ]);
    const message = found[0]?.message ?? '';
    expect(message).toContain("'src/**' and 'src/a/**'");
    expect(message).toContain('src/a/one.ts, src/a/two.ts');
    expect(message).not.toContain('src/b/three.ts');
  });

  it('accepts unordered Tasks whose writable paths are disjoint', () => {
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/a/**'] },
          { key: 'two', writable: ['src/b/**', 'docs/*.md'] },
        ),
      ),
    ).toEqual([]);
  });

  it('accepts overlapping Tasks that a dependency orders, in either listing order', () => {
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/**'] },
          { key: 'two', writable: ['src/a/**'], dependsOn: ['one'] },
        ),
      ),
    ).toEqual([]);
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/**'], dependsOn: ['two'] },
          { key: 'two', writable: ['src/a/**'] },
        ),
      ),
    ).toEqual([]);
  });

  it('accepts overlapping Tasks ordered transitively, through a Task that writes elsewhere', () => {
    expect(
      rules(
        plan(
          { key: 'first', writable: ['src/a/one.ts'] },
          { key: 'middle', writable: ['docs/**'], dependsOn: ['first'] },
          { key: 'last', writable: ['src/a/*.ts'], dependsOn: ['middle'] },
        ),
      ),
    ).toEqual([]);
  });

  it('rejects siblings of one dependency: a shared ancestor orders neither against the other', () => {
    const found = issues(
      plan(
        { key: 'root', writable: ['package.json'] },
        { key: 'left', writable: ['src/a/one.ts'], dependsOn: ['root'] },
        { key: 'right', writable: ['src/a/*.ts'], dependsOn: ['root'] },
      ),
    );
    expect(found.map((i) => i.rule)).toEqual(['plan.no_overlapping_writes']);
    expect(found[0]?.message).toContain('Tasks left and right');
  });

  it('decides by static prefix, so an overlap no tracked file shows yet still counts', () => {
    const found = issues(
      plan({ key: 'one', writable: ['src/new/**'] }, { key: 'two', writable: ['src/new/x.ts'] }),
    );
    expect(found.map((i) => i.rule)).toEqual(['plan.no_overlapping_writes']);
    expect(found[0]?.message).toContain('no tracked file at the planning base matches both');
  });

  it('treats a glob with no static prefix as overlapping everything', () => {
    expect(
      rules(plan({ key: 'one', writable: ['**/*.md'] }, { key: 'two', writable: ['src/a/**'] })),
    ).toEqual(['plan.no_overlapping_writes']);
  });

  it('compares path segments, not characters', () => {
    expect(
      rules(plan({ key: 'one', writable: ['src/a/**'] }, { key: 'two', writable: ['src/ab/**'] })),
    ).toEqual([]);
  });

  it('ignores overlaps between Tasks of different Repositories', () => {
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/**'] },
          { key: 'two', writable: ['src/**'], repository: 'web' },
        ),
      ),
    ).toEqual([]);
  });

  it('names a Repository given by id the same as by name', () => {
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/**'] },
          { key: 'two', writable: ['src/**'], repository: 'repo_app' },
        ),
      ),
    ).toEqual(['plan.no_overlapping_writes']);
  });

  it('reports every overlapping pair once', () => {
    const found = issues(
      plan(
        { key: 'one', writable: ['src/**'] },
        { key: 'two', writable: ['src/a/**', 'src/a/one.ts'] },
        { key: 'three', writable: ['src/b/**'] },
      ),
    );
    expect(found.map((i) => i.message.match(/Tasks (\S+) and (\S+)/)?.slice(1))).toEqual([
      ['one', 'two'],
      ['one', 'three'],
    ]);
  });
});

describe('validatePlan: maxAttempts may only narrow', () => {
  it('accepts a Task maxAttempts at or below the Effective Configuration', () => {
    expect(
      rules(
        plan(
          { key: 'one', writable: ['src/a/**'], maxAttempts: 1 },
          { key: 'two', writable: ['src/b/**'], maxAttempts: 3 },
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a Task maxAttempts above the Effective Configuration', () => {
    const found = issues(plan({ key: 'one', writable: ['src/**'], maxAttempts: 4 }));
    expect(found).toEqual([
      {
        rule: 'plan.max_attempts_narrow',
        message:
          'Task one: maxAttempts 4 is above the Effective Configuration (3); a Plan may only narrow it',
      },
    ]);
  });
});

describe('PlanProposalSchema: priority', () => {
  it('defaults a Task priority to normal and keeps the one given', () => {
    const parsed = PlanProposalSchema.parse({
      tasks: [
        { ...plan({ key: 'one', writable: ['a'] }).tasks[0], priority: undefined },
        { ...plan({ key: 'two', writable: ['b'] }).tasks[0], priority: 'high' },
      ],
    });
    expect(parsed.tasks.map((t) => t.priority)).toEqual(['normal', 'high']);
  });

  it('rejects a priority outside low, normal and high', () => {
    const task = { ...plan({ key: 'one', writable: ['a'] }).tasks[0], priority: 'urgent' };
    expect(PlanProposalSchema.safeParse({ tasks: [task] }).success).toBe(false);
  });
});

const onlyTask = (p: PlanProposal) => {
  const [task] = p.tasks;
  if (task === undefined) throw new Error('the Plan has no Task');
  return task;
};

describe('Sensitive Paths (ADR-0051)', () => {
  const SENSITIVE = ['.env*', '**/.env*', '.github/workflows/**', 'infra/**', 'CLAUDE.md'];
  const withSensitive = ctx({
    sensitivePaths: new Map([
      ['repo_app', SENSITIVE],
      ['repo_web', ['secrets/**']],
    ]),
  });

  it('rejects a writable entry that is literally a Sensitive Path of the Task’s Repository', () => {
    const found = issues(plan({ key: 'one', writable: ['src/**', 'infra/**'] }), withSensitive);
    expect(found).toEqual([
      {
        rule: 'plan.sensitive_writable',
        message:
          "Task one: writable 'infra/**' is a Sensitive Path of Repository app; Sensitive Paths are forbidden for every Task (a human removes one from the Repository Profile to allow it)",
      },
    ]);
  });

  it('judges each Task against its own Repository’s Sensitive Paths, and only literal entries', () => {
    expect(
      rules(
        plan(
          // Another Repository's Sensitive Path, and a glob that only overlaps one.
          { key: 'one', writable: ['secrets/**', 'infra/main.tf'] },
          { key: 'two', writable: ['infra/**'], repository: 'web' },
        ),
        withSensitive,
      ),
    ).toEqual([]);
  });

  it('merges the Sensitive Paths into a Task’s forbidden list, after its own and without duplicates', () => {
    const task = onlyTask(plan({ key: 'one', writable: ['src/**'] }));
    const merged = withSensitivePaths(
      { ...task, scope: { ...task.scope, forbidden: ['package.json', 'infra/**'] } },
      SENSITIVE,
    );
    expect(merged.scope).toEqual({
      writable: ['src/**'],
      forbidden: [
        'package.json',
        'infra/**',
        '.env*',
        '**/.env*',
        '.github/workflows/**',
        'CLAUDE.md',
      ],
      readHints: [],
    });
  });

  it('forbidden beats writable: a Sensitive Path inside a writable glob fails the path gate', () => {
    const task = onlyTask(plan({ key: 'one', writable: ['src/**', 'infra/main.tf'] }));
    const { scope } = withSensitivePaths(task, SENSITIVE);
    const violations = checkPathScope(
      [
        { path: 'src/.env.local', kind: 'added' },
        { path: 'infra/main.tf', kind: 'modified' },
        { path: 'src/ok.ts', kind: 'modified' },
      ],
      scope,
    );
    expect(violations.map((v) => [v.rule, v.paths])).toEqual([
      ['scope.forbidden', ['infra/main.tf', 'src/.env.local']],
    ]);
  });
});
