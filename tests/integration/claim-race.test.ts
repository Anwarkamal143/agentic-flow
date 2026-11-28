/**
 * The claim race (#40, ROADMAP exit test B2, ADR-0020, ADR-0025): two real
 * dispatcher processes race the runtime's exported `claimNextTask` against one
 * real SQLite file in WAL mode, 100 rounds each, no mocks. Every ready Task is
 * claimed exactly once (also when a single ready Task is all both contend
 * for), and no capacity token is ever held twice. Since #99 (ADR-0050) the
 * racers also contend on a Project's `concurrency.perProjectJobs`, through
 * `claimNextTask` and `claimNextProposalStage` at once: no Project ever has
 * more Jobs in flight than its limit, and a second Task of a Job in flight
 * takes no extra Project slot.
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
import { releaseIdleProjectSlot } from '../../apps/runtime/dist/project-slot.js';

const ROUNDS = 100;
const claimerScript = fileURLToPath(new URL('./claimer.mjs', import.meta.url));

interface Token {
  resourceKind: string;
  resourceId: string;
}
interface ProjectSlot {
  kind: 'granted' | 'held';
  resourceId: string;
}
interface Claim {
  jobId: string;
  taskId: string;
  leaseId: string;
  tokens: Token[];
  projectSlot: ProjectSlot;
}
interface ProposalClaim {
  jobId: string;
  stageRunId: string;
  projectSlot: ProjectSlot;
}
interface Claims {
  claims: Claim[];
  proposalClaims: ProposalClaim[];
}
type Reply = ({ round: number } & Claims) | { round: number; error: string };

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

  /**
   * Claims until nothing more can be claimed (with `proposals`, queued proposal
   * Stage Runs too); resolves with this process's claims.
   */
  claim(round: number, globalLimit: number, proposals = false): Promise<Claims> {
    return new Promise((resolve, reject) => {
      this.waiting.set(round, (reply) => {
        if ('error' in reply) reject(new Error(`${this.holder}: ${reply.error}`));
        else resolve(reply);
      });
      this.proc.send({ round, globalLimit, proposals });
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
/** A second Project, with `concurrency.perProjectJobs` {@link PROJECT_LIMIT}. */
let limited: { projectId: string; repositoryId: string };
const PROJECT_LIMIT = 2;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'claim-race-')));
  const dbPath = join(dir, 'factory.db');
  handle = openDatabase(dbPath);
  expect(handle.journalMode).toBe('wal');
  ({ projectId, repositoryId } = seedProject(handle, 'race', {}));
  limited = seedProject(handle, 'limited', { concurrency: { perProjectJobs: PROJECT_LIMIT } });
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
      (await c.claim(round, globalLimit)).claims.map((claim) => ({ ...claim, holder: c.holder })),
    ),
  );
  return replies.flat();
}

/** Both dispatchers race for the round's ready Tasks and queued proposal Stage Runs. */
async function raceAll(round: number, globalLimit: number): Promise<Claims> {
  const replies = await Promise.all(claimers.map((c) => c.claim(round, globalLimit, true)));
  return {
    claims: replies.flatMap((r) => r.claims),
    proposalClaims: replies.flatMap((r) => r.proposalClaims),
  };
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

  it(`one ready Task, both dispatchers contend: exactly one claim succeeds, ${String(ROUNDS)} rounds`, async () => {
    const winners = new Set<string>();
    for (let round = 2 * ROUNDS; round < 3 * ROUNDS; round++) {
      // Room for both: only the single ready Task limits the claims.
      const { jobId, taskIds } = seedReadyJob(handle, round, 1, { perRepository: 3, perJob: 3 });
      const claims = await race(round, 3);

      expect(claims).toHaveLength(1);
      expect(claims[0]?.taskId).toBe(taskIds[0]);
      for (const claim of claims) winners.add(claim.holder);
      expectClaimsRecorded(jobId, claims);
      expectNoTokenHeldTwice(claims);
      releaseAll(claims);
    }
    // The race is real: each process won the Task in some rounds.
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

  it(`never lets a Project exceed perProjectJobs, Tasks and proposal Stages racing, ${String(ROUNDS)} rounds`, async () => {
    let proposalRounds = 0;
    let taskRounds = 0;
    for (let round = 3 * ROUNDS; round < 4 * ROUNDS; round++) {
      // Five Jobs of one Project with room for two: three with two ready Tasks each,
      // two with a queued triage. Every other limit has room for everything.
      const taskJobs = [0, 1, 2].map((tag) =>
        seedReadyJob(handle, round, 2, { perRepository: 16, perJob: 2 }, { ...limited, tag }),
      );
      const proposalJobs = [0, 1].map((tag) => seedProposalJob(handle, round, tag));
      const { claims, proposalClaims } = await raceAll(round, 16);

      // Exactly the limit is in flight: never more, and the claimers stop only when it is full.
      const inFlight = new Set([...claims, ...proposalClaims].map((c) => c.jobId));
      expect(inFlight.size).toBe(PROJECT_LIMIT);
      // One slot per Job in flight, under the Job's lease id: the lowest two.
      expect(projectSlots().map((s) => s.split('@')[0])).toEqual([
        `${limited.projectId}:0`,
        `${limited.projectId}:1`,
      ]);
      expect(
        projectSlots()
          .map((s) => s.split('@')[1])
          .sort(),
      ).toEqual([...inFlight].map((jobId) => `job:${jobId}`).sort());
      // A Job in flight with Tasks gets both: the first takes the slot, the second takes none.
      for (const { jobId, taskIds } of taskJobs) {
        const mine = claims.filter((c) => c.jobId === jobId);
        if (!inFlight.has(jobId)) {
          expect(mine).toEqual([]);
          continue;
        }
        expect(mine.map((c) => c.taskId).sort()).toEqual([...taskIds].sort());
        expect(mine.map((c) => c.projectSlot.kind).sort()).toEqual(['granted', 'held']);
        expect(new Set(mine.map((c) => c.projectSlot.resourceId)).size).toBe(1);
      }
      for (const claim of proposalClaims) expect(claim.projectSlot.kind).toBe('granted');
      expect(stageStates(proposalJobs.map((j) => j.stageRunId))).toEqual(
        proposalJobs.map((j) =>
          proposalClaims.some((c) => c.stageRunId === j.stageRunId) ? 'running' : 'queued',
        ),
      );
      if (proposalClaims.length > 0) proposalRounds++;
      if (claims.length > 0) taskRounds++;

      // The slot goes with the Job's last work in flight, not with its first Task.
      for (const { jobId } of taskJobs.filter((j) => inFlight.has(j.jobId))) {
        const [first, second] = claims.filter((c) => c.jobId === jobId);
        if (first === undefined || second === undefined) throw new Error('two claims expected');
        releaseAll([first]);
        expect(projectSlots().some((s) => s.endsWith(`@job:${jobId}`))).toBe(true);
        releaseAll([second]);
        expect(projectSlots().some((s) => s.endsWith(`@job:${jobId}`))).toBe(false);
      }
      finishProposals(proposalClaims);
      expect(projectSlots()).toEqual([]);

      // Leave nothing claimable for the next round to find.
      handle.db
        .update(schema.tasks)
        .set({ state: 'cancelled' })
        .where(
          and(
            inArray(
              schema.tasks.jobId,
              taskJobs.map((j) => j.jobId),
            ),
            eq(schema.tasks.state, 'ready'),
          ),
        )
        .run();
      handle.db
        .update(schema.stageRuns)
        .set({ state: 'cancelled' })
        .where(
          and(
            inArray(
              schema.stageRuns.id,
              proposalJobs.map((j) => j.stageRunId),
            ),
            eq(schema.stageRuns.state, 'queued'),
          ),
        )
        .run();
    }
    // Both claim paths took Project slots in the race.
    expect(proposalRounds).toBeGreaterThan(0);
    expect(taskRounds).toBeGreaterThan(0);
  });
});

/** Every held Project slot, as `<resource-id>@<lease-id>`, sorted. */
function projectSlots(): string[] {
  return handle.db
    .select()
    .from(schema.leases)
    .where(eq(schema.leases.resourceKind, CAPACITY_RESOURCE.project))
    .all()
    .map((l) => `${l.resourceId}@${l.leaseId}`)
    .sort();
}

function stageStates(ids: string[]): string[] {
  return ids.map(
    (id) =>
      handle.db
        .select({ state: schema.stageRuns.state })
        .from(schema.stageRuns)
        .where(eq(schema.stageRuns.id, id))
        .get()?.state ?? 'missing',
  );
}

/** Ends the round's proposal Stage Runs, as the Stage scheduler would, freeing idle slots. */
function finishProposals(claims: ProposalClaim[]): void {
  handle.db.transaction(
    (tx) => {
      for (const claim of claims) {
        tx.update(schema.stageRuns)
          .set({ state: 'succeeded' })
          .where(eq(schema.stageRuns.id, claim.stageRunId))
          .run();
        releaseIdleProjectSlot(tx, claim.jobId);
      }
    },
    { behavior: 'immediate' },
  );
}

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
    .filter((l) => l.resourceKind !== CAPACITY_RESOURCE.project)
    .map((l) => `${l.resourceKind}/${l.resourceId}@${l.leaseId}`);
  expect(held.sort()).toEqual(claimed.sort());
  // The Project slots are the Jobs': one per Job in flight (this Project is unlimited).
  const jobs = [...new Set(claims.map((c) => `job:${c.jobId}`))].sort();
  expect(
    projectSlots()
      .map((s) => s.split('@')[1])
      .sort(),
  ).toEqual(jobs);
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

function seedProject(
  h: DatabaseHandle,
  name: string,
  config: Record<string, unknown>,
): { projectId: string; repositoryId: string } {
  const now = new Date().toISOString();
  const project = {
    id: `prj_${name}`,
    name,
    configJson: JSON.stringify(ProjectConfigSchema.parse(config)),
    createdAt: now,
  };
  h.db.insert(schema.projects).values(project).run();
  const profile = RepositoryProfileSchema.parse({
    version: 1,
    packageManager: null,
    commands: { test: null, typecheck: null },
    confirmedBy: 'user:local',
    confirmedAt: now,
  });
  const repository = {
    id: `rep_${name}`,
    projectId: project.id,
    name,
    // Never read by the claim: no git work happens in this tier.
    source: `/nonexistent/${name}-source`,
    clonePath: `/nonexistent/${name}-clone`,
    defaultBranch: 'main',
    profileJson: JSON.stringify(profile),
    createdAt: now,
  };
  h.db.insert(schema.repositories).values(repository).run();
  return { projectId: project.id, repositoryId: repository.id };
}

/**
 * A Job at `execution` (queued) with `count` ready Tasks on one Repository: the
 * race Project's, or `target`'s (`tag` tells a round's Jobs apart).
 */
function seedReadyJob(
  h: DatabaseHandle,
  round: number,
  count: number,
  concurrency: { perRepository: number; perJob: number },
  target?: { projectId: string; repositoryId: string; tag: number },
): { jobId: string; taskIds: string[] } {
  const suffix = target === undefined ? String(round) : `${String(round)}_${String(target.tag)}`;
  return seedJob(h, {
    suffix,
    queued: 'execution',
    taskCount: count,
    concurrency,
    projectId: target?.projectId ?? projectId,
    repositoryId: target?.repositoryId ?? repositoryId,
  });
}

/** A Job of the limited Project whose `triage` Stage Run is queued. */
function seedProposalJob(
  h: DatabaseHandle,
  round: number,
  tag: number,
): { jobId: string; stageRunId: string } {
  const suffix = `${String(round)}_p${String(tag)}`;
  const { jobId } = seedJob(h, {
    suffix,
    queued: 'triage',
    taskCount: 0,
    concurrency: { perRepository: 16, perJob: 2 },
    ...limited,
  });
  const triageAt = FEATURE_RECIPE.stages.findIndex((s) => s.id === 'triage');
  return { jobId, stageRunId: `stg_race_${suffix}_${String(triageAt)}` };
}

function seedJob(
  h: DatabaseHandle,
  input: {
    suffix: string;
    /** The Stage queued; the ones before it succeeded. */
    queued: StageId;
    taskCount: number;
    concurrency: { perRepository: number; perJob: number };
    projectId: string;
    repositoryId: string;
  },
): { jobId: string; taskIds: string[] } {
  const { suffix } = input;
  const jobId = `job_race_${suffix}`;
  const now = new Date().toISOString();
  const resolved = resolveEffectiveConfig({
    project: ProjectConfigSchema.parse({}),
    job: { concurrency: input.concurrency },
  });
  if (!resolved.ok) throw new Error(resolved.message);
  const config = resolved.config;
  const queuedAt = FEATURE_RECIPE.stages.findIndex((s) => s.id === input.queued);
  const stageState = (position: number): StageRunState =>
    position < queuedAt ? 'succeeded' : position === queuedAt ? 'queued' : 'pending';
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

  const taskIds = Array.from(
    { length: input.taskCount },
    (_, i) => `tsk_race_${suffix}_${String(i)}`,
  );
  h.db.transaction(
    (tx) => {
      tx.insert(schema.jobs)
        .values({
          id: jobId,
          projectId: input.projectId,
          title: `race ${suffix}`,
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
      tx.insert(schema.jobRepositories).values({ jobId, repositoryId: input.repositoryId }).run();
      tx.insert(schema.stageRuns)
        .values(
          runs.map((run, position) => ({
            id: `stg_race_${suffix}_${String(position)}`,
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
      appendEvent(tx, {
        entityKind: 'stage_run',
        entityId: `stg_race_${suffix}_${String(queuedAt)}`,
        jobId,
        type: 'stage_run.queued',
        actor: 'test:seed',
        payload: { stageId: input.queued, from: 'pending', to: 'queued' },
      });
      if (taskIds.length === 0) return;
      const planId = `art_race_${suffix}`;
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
            repositoryId: input.repositoryId,
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
