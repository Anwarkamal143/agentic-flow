/**
 * The Plan validator's Phase B rules (ARCHITECTURE §7): a Task's `maxAttempts`
 * may only narrow the Effective Configuration, and Tasks that no dependency
 * path orders must not write overlapping paths. Every problem names its rule,
 * so the one re-prompt can carry it back to the planner.
 */
import {
  checkPathScope,
  PlanProposalSchema,
  resolveVerification,
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
  acceptance?: string[];
  deferred?: boolean;
  verification?: { key: string; command: string; args?: string[]; criteria?: string[] }[];
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
      acceptance: t.acceptance ?? ['AC-01'],
      verification: t.verification ?? [
        { key: 'test', command: 'pass', criteria: t.acceptance ?? ['AC-01'] },
      ],
      ...(t.deferred === undefined ? {} : { deferred: t.deferred }),
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

/** The one profile command the default Plan's verification names. */
const PASS = { pass: { run: 'true', acceptsArgs: false } };

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
  commands: new Map([
    ['repo_app', PASS],
    ['repo_web', PASS],
  ]),
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

describe('verification by profile command name (ADR-0051)', () => {
  const COMMANDS = {
    test: { run: 'pnpm vitest run', acceptsArgs: true },
    lint: { run: 'pnpm lint', acceptsArgs: false },
  };
  const withCommands = ctx({ commands: new Map([['repo_app', COMMANDS]]) });
  const verifying = (entry: { command: string; args?: string[] }) =>
    plan({
      key: 'one',
      writable: ['src/**'],
      verification: [{ key: 'v', criteria: ['AC-01'], ...entry }],
    });

  it('accepts a profile command, with arguments when it accepts them', () => {
    expect(rules(verifying({ command: 'lint' }), withCommands)).toEqual([]);
    expect(
      rules(
        verifying({
          command: 'test',
          args: ['tests/unit/a.test.ts', '--reporter=dot', 'a@1,b+c:d'],
        }),
        withCommands,
      ),
    ).toEqual([]);
  });

  it('refuses a free shell verification command, naming the profile commands (#104)', () => {
    expect(issues(verifying({ command: 'grep -q sum src/math.ts' }), withCommands)).toEqual([
      {
        rule: 'plan.verification_command',
        message:
          "Task one: verification v: 'grep -q sum src/math.ts' is not a profile command of Repository app (lint, test); a verification entry names one of its Repository's profile commands, never free shell",
      },
    ]);
    // A Repository with no profile commands accepts no verification entry.
    expect(issues(verifying({ command: 'npm install' }), ctx({ commands: new Map() }))).toEqual([
      {
        rule: 'plan.verification_command',
        message:
          "Task one: verification v: 'npm install' is not a profile command of Repository app (it has none); a verification entry names one of its Repository's profile commands, never free shell",
      },
    ]);
  });

  it('refuses arguments on a profile command that does not accept them', () => {
    expect(issues(verifying({ command: 'lint', args: ['src'] }), withCommands)).toEqual([
      {
        rule: 'plan.verification_args',
        message:
          "Task one: verification v: profile command 'lint' of Repository app does not accept arguments (a human marks it acceptsArgs in the Repository Profile)",
      },
    ]);
  });

  it('refuses an argument outside the allowlist, naming it and the pattern', () => {
    for (const arg of ['a b', "x'y", '$(id)', 'a;b', '`x`', '', 'a|b', '~/x', 'a*', 'a\nb']) {
      expect(issues(verifying({ command: 'test', args: [arg] }), withCommands)).toEqual([
        {
          rule: 'plan.verification_args',
          message: `Task one: verification v: argument ${JSON.stringify(arg)} must match ^[A-Za-z0-9._/:=@+,-]+$`,
        },
      ]);
    }
  });

  it('refuses a command that is not one of the Repository’s profile commands once, with or without arguments', () => {
    expect(issues(verifying({ command: 'echo', args: ['hi'] }), withCommands)).toEqual([
      {
        rule: 'plan.verification_command',
        message:
          "Task one: verification v: 'echo' is not a profile command of Repository app (lint, test); a verification entry names one of its Repository's profile commands, never free shell",
      },
    ]);
    // Each Task is judged against its own Repository's commands.
    expect(
      rules(
        plan({
          key: 'one',
          writable: ['src/**'],
          repository: 'web',
          verification: [{ key: 'v', command: 'test', args: ['x'], criteria: ['AC-01'] }],
        }),
        withCommands,
      ),
    ).toEqual(['plan.verification_command']);
  });

  it('resolves a profile command to its run, each argument shell-quoted and appended', () => {
    expect(
      resolveVerification({ command: 'test', args: ['tests/a.test.ts', '-t'] }, COMMANDS),
    ).toEqual({
      run: "pnpm vitest run 'tests/a.test.ts' '-t'",
      profileCommand: { name: 'test', args: ['tests/a.test.ts', '-t'] },
    });
    expect(resolveVerification({ command: 'lint' }, COMMANDS)).toEqual({
      run: 'pnpm lint',
      profileCommand: { name: 'lint', args: [] },
    });
  });

  it('runs a stored entry that names no profile command as written (a Plan accepted before #104)', () => {
    expect(resolveVerification({ command: 'grep -q sum src/math.ts' }, COMMANDS)).toEqual({
      run: 'grep -q sum src/math.ts',
      profileCommand: null,
    });
  });
});

describe('validatePlan: cross-repo dependency cycles (ADR-0052)', () => {
  it('accepts a cross-repo edge: the Delivery Order is defined', () => {
    expect(
      rules(
        plan(
          { key: 'expand', writable: ['src/**'] },
          { key: 'use', writable: ['src/**'], repository: 'web', dependsOn: ['expand'] },
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a cycle between Repositories that no Task cycle shows, naming the Repositories', () => {
    const found = issues(
      plan(
        { key: 'a', writable: ['src/a/**'] },
        { key: 'b', writable: ['src/**'], repository: 'web', dependsOn: ['a'] },
        { key: 'c', writable: ['src/b/**'], dependsOn: ['b'] },
      ),
    );
    expect(found).toEqual([
      {
        rule: 'plan.delivery_order_cycle',
        message:
          'cross-repo dependency cycle: app → web → app; the Delivery Order must be defined, so no Repository may depend on a Repository that depends on it',
      },
    ]);
  });

  it('reports a Task cycle once, as plan.no_cycles', () => {
    expect(
      rules(
        plan(
          { key: 'a', writable: ['src/**'], dependsOn: ['b'] },
          { key: 'b', writable: ['src/**'], repository: 'web', dependsOn: ['a'] },
        ),
      ),
    ).toEqual(['plan.no_cycles']);
  });
});

describe('validatePlan: deferred contract Tasks (ADR-0052, #110)', () => {
  // expand (app) → migrate (web) → contract (app): the contract step removes the old interface.
  const contract = (over: Partial<TaskOver> = {}) =>
    plan(
      { key: 'expand', writable: ['src/a/**'] },
      { key: 'migrate', writable: ['src/**'], repository: 'web', dependsOn: ['expand'] },
      { key: 'contract', writable: ['src/a/**'], dependsOn: ['migrate'], deferred: true, ...over },
    );

  it('defaults a Task to not deferred and keeps deferred: true', () => {
    const parsed = contract();
    expect(parsed.tasks.map((t) => [t.key, t.deferred])).toEqual([
      ['expand', false],
      ['migrate', false],
      ['contract', true],
    ]);
  });

  it('leaves a deferred Task out of the Delivery Order and the overlap check', () => {
    // Without deferred, contract makes app → web → app a cycle.
    expect(rules(contract())).toEqual([]);
    expect(rules(contract({ deferred: false }))).toEqual(['plan.delivery_order_cycle']);
    // Unordered with expand and on its paths: it never runs beside it.
    expect(rules(contract({ dependsOn: [] }))).toEqual([]);
    expect(rules(contract({ dependsOn: [], deferred: false }))).toEqual([
      'plan.no_overlapping_writes',
    ]);
  });

  it('refuses a Task that runs but depends on a deferred one', () => {
    const found = issues(
      plan(
        { key: 'expand', writable: ['src/a/**'] },
        { key: 'contract', writable: ['src/b/**'], dependsOn: ['expand'], deferred: true },
        { key: 'after', writable: ['src/**'], repository: 'web', dependsOn: ['contract'] },
      ),
    );
    expect(found).toEqual([
      {
        rule: 'plan.deferred_dependency',
        message:
          'Task after depends on deferred Task contract, which does not run in this Job; a deferred Task is the contract step, offered as a follow-up Job once every pull request has merged',
      },
    ]);
  });

  it('counts only Tasks that run toward a mandatory criterion', () => {
    expect(
      issues(
        plan(
          { key: 'expand', writable: ['src/a/**'], acceptance: [] },
          { key: 'contract', writable: ['src/b/**'], dependsOn: ['expand'], deferred: true },
        ),
        ctx({ criteria: [{ code: 'AC-01', mandatory: true }] }),
      ),
    ).toEqual([
      {
        rule: 'plan.mandatory_criteria_covered',
        message: 'mandatory AC-01 is covered by no Task that runs in this Job (deferred Tasks do not)',
      },
    ]);
  });

  it('refuses a Plan whose every Task is deferred', () => {
    expect(rules(plan({ key: 'contract', writable: ['src/**'], deferred: true }))).toContain(
      'plan.no_runnable_task',
    );
  });

  it('refuses an upstream Task with a dependent in another Repository that covers no criterion: the contract is verified, not assumed (story 60)', () => {
    const found = issues(
      plan(
        { key: 'expand', writable: ['src/a/**'], acceptance: [] },
        { key: 'migrate', writable: ['src/**'], repository: 'web', dependsOn: ['expand'] },
      ),
    );
    expect(found).toEqual([
      {
        rule: 'plan.contract_criteria',
        message:
          'Task expand: Task migrate of Repository web depends on it, so it must cover the Acceptance Criteria that state the contract (the interface migrate codes against)',
      },
    ]);
  });
});
