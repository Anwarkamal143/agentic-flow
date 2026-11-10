/**
 * The claim race (#40, ROADMAP exit test B2, ADR-0020, ADR-0025): two real
 * dispatcher processes race the runtime's exported `claimNextTask` against one
 * real SQLite file in WAL mode, 100 rounds each, no mocks. Every ready Task is
 * claimed exactly once, and no capacity token is ever held twice.
 *
 * This tier is test-only. The test process seeds each round's ready Tasks
 * straight into the database and releases the claims after it; two processes
 * claiming at once exist only here. In production only the runtime writes the
 * database (CLAUDE.md "one writer").
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, openDatabase, schema, type DatabaseHandle } from '@factory/db';
import {
  CAPACITY_RESOURCE,
  deriveJobStatus,
  FEATURE_RECIPE,
  ProjectConfigSchema,
  RepositoryProfileSchema,
  resolveEffectiveConfig,
  TaskDefinitionSchema,
  type StageId,
  type StageRunState,
} from '@factory/domain';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseClaim } from '../../apps/runtime/dist/claim.js';

const ROUNDS = 100;
const claimerScript = fileURLToPath(new URL('./claimer.mjs', import.meta.url));

interface Token {
  resourceKind: string;
  resourceId: string;
}
interface Claim {
  jobId: string;
  taskId: string;
  leaseId: string;
  tokens: Token[];
}
type Reply = { round: number; claims: Claim[] } | { round: number; error: string };

/** A forked dispatcher (`claimer.mjs`) with its own database connection. */
class Claimer {
  private readonly proc: ChildProcess;
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  readonly ready: Promise<void>;

  constructor(
    dbPath: string,
    readonly holder: string,
  ) {
    this.proc = fork(claimerScript, [dbPath, holder], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.ready = new Promise((resolve, reject) => {
      this.proc.once('error', reject);
      this.proc.once('exit', (code) => {
        reject(new Error(`${holder} exited (${String(code)}) before it was ready`));
      });
      this.proc.on('message', (msg: Reply | { ready: true }) => {
        if ('ready' in msg) {
          resolve();
          return;
        }
        this.waiting.get(msg.round)?.(msg);
        this.waiting.delete(msg.round);
      });
    });
  }

  /** Claims until nothing more can be claimed; resolves with this process's claims. */
  claim(round: number, globalLimit: number): Promise<Claim[]> {
    return new Promise((resolve, reject) => {
      this.waiting.set(round, (reply) => {
        if ('error' in reply) reject(new Error(`${this.holder}: ${reply.error}`));
        else resolve(reply.claims);
      });
      this.proc.send({ round, globalLimit });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve();
        return;
      }
      this.proc.once('exit', () => {
        resolve();
      });
      this.proc.send('exit');
    });
  }
}

let dir: string;
let handle: DatabaseHandle;
let claimers: [Claimer, Claimer];
let projectId: string;
let repositoryId: string;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'claim-race-')));
  const dbPath = join(dir, 'factory.db');
  handle = openDatabase(dbPath);
  expect(handle.journalMode).toBe('wal');
  ({ projectId, repositoryId } = seedProject(handle));
  claimers = [new Claimer(dbPath, 'runtime:race-a'), new Claimer(dbPath, 'runtime:race-b')];
  await Promise.all(claimers.map((c) => c.ready));
});

afterAll(async () => {
  await Promise.all(claimers.map((c) => c.stop()));
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Both dispatchers race for the round's ready Tasks; the round's claims, with who made them. */
async function race(round: number, globalLimit: number): Promise<(Claim & { holder: string })[]> {
  const replies = await Promise.all(
    claimers.map(async (c) =>
      (await c.claim(round, globalLimit)).map((claim) => ({ ...claim, holder: c.holder })),
    ),
  );
  return replies.flat();
}

describe('two dispatchers racing for ready Tasks', () => {
  it(`claims every ready Task exactly once, ${String(ROUNDS)} rounds`, async () => {
    const winners = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      // Room for all three: every ready Task must be claimed, by exactly one process.
      const { jobId, taskIds } = seedReadyJob(handle, round, 3, { perRepository: 3, perJob: 3 });
      const claims = await race(round, 3);

      expect(claims.map((c) => c.taskId).sort()).toEqual([...taskIds].sort());
      for (const claim of claims) winners.add(claim.holder);
      expectClaimsRecorded(jobId, claims);
      expectNoTokenHeldTwice(claims);
      releaseAll(claims);
    }
    // The race is real: each process won some of the Tasks.
    expect([...winners].sort()).toEqual(['runtime:race-a', 'runtime:race-b']);
  });

  it(`never holds a capacity token twice at the limits, ${String(ROUNDS)} rounds`, async () => {
    for (let round = ROUNDS; round < 2 * ROUNDS; round++) {
      // Three ready Tasks, room for two: the global limit (2) and the Job's (2) are reached.
      const { jobId, taskIds } = seedReadyJob(handle, round, 3, { perRepository: 3, perJob: 2 });
      const claims = await race(round, 2);

      expect(claims).toHaveLength(2);
      expect(new Set(claims.map((c) => c.taskId)).size).toBe(2);
      const unclaimed = taskIds.filter((id) => !claims.some((c) => c.taskId === id));
      expect(taskStates(unclaimed)).toEqual(['ready']);
      expectClaimsRecorded(jobId, claims);
      expectNoTokenHeldTwice(claims);
      // The lowest free slot of each kind, one per claim.
      expect(slots(claims, CAPACITY_RESOURCE.global)).toEqual(['0', '1']);
      expect(slots(claims, CAPACITY_RESOURCE.job)).toEqual([`${jobId}:0`, `${jobId}:1`]);
      expect(slots(claims, CAPACITY_RESOURCE.repository)).toEqual([
        `${repositoryId}:0`,
        `${repositoryId}:1`,
      ]);
      releaseAll(claims);
      // Leave nothing ready for the next round to find.
      handle.db
        .update(schema.tasks)
        .set({ state: 'cancelled' })
        .where(inArray(schema.tasks.id, unclaimed))
        .run();
    }
  });
});

/** Each claimed Task is `claimed` with one `task.claimed` event and one lease, the winner's. */
function expectClaimsRecorded(jobId: string, claims: (Claim & { holder: string })[]): void {
  for (const claim of claims) {
    expect(claim.jobId).toBe(jobId);
    expect(taskStates([claim.taskId])).toEqual(['claimed']);
    const claimed = handle.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.entityId, claim.taskId), eq(schema.events.type, 'task.claimed')))
      .all();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.actor).toBe(claim.holder);
    const lease = handle.db
      .select()
      .from(schema.leases)
      .where(
        and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, claim.taskId)),
      )
      .all();
    expect(lease.map((l) => [l.holder, l.leaseId])).toEqual([[claim.holder, claim.leaseId]]);
  }
}

/** No token is in two claims, and the held tokens are exactly the claims' tokens, under their leases. */
function expectNoTokenHeldTwice(claims: Claim[]): void {
  const claimed = claims.flatMap((c) =>
    c.tokens.map((t) => `${t.resourceKind}/${t.resourceId}@${c.leaseId}`),
  );
  const keys = claimed.map((k) => k.split('@')[0]);
  expect(new Set(keys).size).toBe(keys.length);
  // Three tokens per claim: global, Repository, Job.
  expect(keys).toHaveLength(3 * claims.length);
  const held = handle.db
    .select()
    .from(schema.leases)
    .where(like(schema.leases.resourceKind, 'capacity.%'))
    .all()
    .map((l) => `${l.resourceKind}/${l.resourceId}@${l.leaseId}`);
  expect(held.sort()).toEqual(claimed.sort());
}

function slots(claims: Claim[], kind: string): string[] {
  return claims
    .flatMap((c) => c.tokens.filter((t) => t.resourceKind === kind).map((t) => t.resourceId))
    .sort();
}

function taskStates(ids: string[]): string[] {
  return handle.db
    .select({ state: schema.tasks.state })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, ids))
    .all()
    .map((t) => t.state);
}

/** Ends the round: each Task's lease and tokens go, as when its Attempt ends. */
function releaseAll(claims: Claim[]): void {
  handle.db.transaction(
    (tx) => {
      for (const claim of claims) releaseClaim(tx, claim.taskId);
    },
    { behavior: 'immediate' },
  );
}

// ---- Seeding (test-only: these rows stand in for intake, planning and plan approval) ----

function seedProject(h: DatabaseHandle): { projectId: string; repositoryId: string } {
  const now = new Date().toISOString();
  const project = { id: 'prj_race', name: 'race', configJson: '{}', createdAt: now };
  h.db.insert(schema.projects).values(project).run();
  const profile = RepositoryProfileSchema.parse({
    version: 1,
    packageManager: null,
    commands: { test: null, typecheck: null },
    confirmedBy: 'user:local',
    confirmedAt: now,
  });
  const repository = {
    id: 'rep_race',
    projectId: project.id,
    name: 'race',
    // Never read by the claim: no git work happens in this tier.
    source: '/nonexistent/race-source',
    clonePath: '/nonexistent/race-clone',
    defaultBranch: 'main',
    profileJson: JSON.stringify(profile),
    createdAt: now,
  };
  h.db.insert(schema.repositories).values(repository).run();
  return { projectId: project.id, repositoryId: repository.id };
}

/** A Job at `execution` (queued) with `count` ready Tasks on the one Repository. */
function seedReadyJob(
  h: DatabaseHandle,
  round: number,
  count: number,
  concurrency: { perRepository: number; perJob: number },
): { jobId: string; taskIds: string[] } {
  const jobId = `job_race_${String(round)}`;
  const now = new Date().toISOString();
  const config = resolveEffectiveConfig({
    project: ProjectConfigSchema.parse({}),
    job: { concurrency },
  });
  const executionAt = FEATURE_RECIPE.stages.findIndex((s) => s.id === 'execution');
  const stageState = (position: number): StageRunState =>
    position < executionAt ? 'succeeded' : position === executionAt ? 'queued' : 'pending';
  const runs = FEATURE_RECIPE.stages.map((stage, position) => ({
    stageId: stage.id satisfies StageId,
    state: stageState(position),
  }));
  const definition = TaskDefinitionSchema.parse({
    objective: 'Race for the claim',
    role: 'developer',
    risk: 'low',
    scope: { writable: ['src/**'] },
    dependsOn: [],
    acceptance: [],
    verification: [],
  });

  const taskIds = Array.from({ length: count }, (_, i) => `tsk_race_${String(round)}_${String(i)}`);
  h.db.transaction(
    (tx) => {
      tx.insert(schema.jobs)
        .values({
          id: jobId,
          projectId,
          title: `race ${String(round)}`,
          description: 'claim race fixture',
          type: 'feature',
          priority: 'normal',
          status: deriveJobStatus(runs),
          workflowSnapshotJson: JSON.stringify(FEATURE_RECIPE),
          configSnapshotJson: JSON.stringify(config),
          createdBy: 'user:local',
          createdAt: now,
          version: 0,
        })
        .run();
      tx.insert(schema.jobRepositories).values({ jobId, repositoryId }).run();
      tx.insert(schema.stageRuns)
        .values(
          runs.map((run, position) => ({
            id: `stg_race_${String(round)}_${String(position)}`,
            jobId,
            stageId: run.stageId,
            position,
            state: run.state,
            attempt: 1,
            startedAt: run.state === 'succeeded' ? now : null,
            finishedAt: run.state === 'succeeded' ? now : null,
            version: 0,
          })),
        )
        .run();
      const planId = `art_race_${String(round)}`;
      tx.insert(schema.artifacts)
        .values({
          id: planId,
          jobId,
          kind: 'plan',
          contentHash: 'race-fixture',
          path: `artifacts/${planId}.json`,
          schemaVersion: 1,
          createdAt: now,
        })
        .run();
      taskIds.forEach((id, i) => {
        tx.insert(schema.tasks)
          .values({
            id,
            jobId,
            repositoryId,
            planArtifactId: planId,
            key: `T${String(i + 1)}`,
            title: `Task ${String(i + 1)}`,
            definitionJson: JSON.stringify(definition),
            state: 'ready',
            priority: 0,
            maxAttempts: config.maxAttempts.value,
            version: 0,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'task',
          entityId: id,
          jobId,
          type: 'task.created',
          actor: 'test:seed',
          payload: { key: `T${String(i + 1)}` },
        });
      });
    },
    { behavior: 'immediate' },
  );
  return { jobId, taskIds };
}
