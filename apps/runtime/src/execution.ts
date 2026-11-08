/**
 * The Task scheduler, Phase A: one concurrency slot. It runs the `execution`
 * Stage (claim a ready Task, give it a Worktree, run the developer Harness,
 * verify the result itself) and the `closure` Stage (the Delivery Report, then
 * Worktree removal). ARCHITECTURE §7, §10, §12.
 *
 * After a Harness Run the factory trusts nothing it said: the head commit and
 * the commits come from git, leftovers become a flagged WIP commit, and every
 * verification command is run again by the factory, its exit code recorded as
 * Evidence tied to `(head_sha, base_sha)`.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  criterionVerdict,
  RESULT_FILE,
  schemaIssues,
  SpecificationProposalSchema,
  DiscoveryProposalSchema,
  TaskDefinitionSchema,
  TaskPacketSchema,
  TaskResultSchema,
  type AttemptExitReason,
  type AttemptState,
  type EvidenceVerdict,
  type RuleIssue,
  type TaskDefinition,
  type TaskPacket,
  type TaskResult,
  type Usage,
  type WorktreeState,
} from '@factory/domain';
import {
  addWorktree,
  commitAll,
  commitsBetween,
  fetchRemote,
  infoExcludePath,
  removeWorktree,
  resolveCommit,
  uncommittedPaths,
} from '@factory/git';
import {
  guardrailEnv,
  spawnGuarded,
  type AgentHarness,
  type GuardedProcess,
  type HarnessRawResult,
  type HarnessRun,
} from '@factory/harness';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ArtifactStore, StoredContent } from './artifacts.js';
import { buildDeliveryReport } from './delivery.js';
import { changeJob, stepTask, type JobState, type StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { renderTaskPrompt, TASK_TEMPLATE_HASH, TASK_TEMPLATE_ID } from './task-packet.js';

const ACTOR = 'system:scheduler';
const POLL_MS = 1_000;
const PORT_BLOCK_START = 42_000;
const PORT_BLOCK_SIZE = 10;
const PORT_BLOCKS = 1_000;
const MAX_TURNS = 50;

export interface TaskSchedulerOptions {
  db: FactoryDb;
  /** `undefined`: no Harness is configured, so ready Tasks wait. */
  harness: AgentHarness | undefined;
  harnessVersion: string | null;
  artifacts: ArtifactStore;
  workspaceRoot: string;
  /** The runtime's environment; only allowlisted variables reach a guarded process. */
  runtimeEnv: NodeJS.ProcessEnv;
  onCommit: () => void;
  log: (message: string) => void;
  /** Wall-clock limit of one developer Harness Run. */
  wallClockMs?: number;
  /** Wall-clock limit of one verification command. */
  verifyTimeoutMs?: number;
}

type TaskRow = typeof schema.tasks.$inferSelect;
type WorktreeRow = typeof schema.worktrees.$inferSelect;

/** What the factory found in the Worktree after the Run. */
interface Inspection {
  headSha: string;
  commits: string[];
  wipCommit: string | null;
  result:
    | { kind: 'missing' }
    | { kind: 'invalid'; issues: RuleIssue[]; content: unknown }
    | { kind: 'valid'; value: TaskResult };
  violations: RuleIssue[];
}

interface RunRecord {
  key: string;
  command: string;
  required: boolean;
  criteria: string[];
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  durationMs: number;
  content: StoredContent;
}

interface Outcome {
  state: Extract<AttemptState, 'passed' | 'failed'>;
  exitReason: AttemptExitReason;
  detail: string;
}

export class TaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private wakeScheduled = false;
  private busy: Promise<void> | undefined;
  private currentRun: HarnessRun | undefined;
  private currentProc: GuardedProcess | undefined;
  private closed = false;
  private readonly holder = `runtime:${String(process.pid)}`;

  constructor(private readonly opts: TaskSchedulerOptions) {}

  start(): void {
    if (this.opts.harness === undefined) return;
    this.timer = setInterval(() => {
      this.wake();
    }, POLL_MS);
    this.wake();
  }

  wake(): void {
    if (this.wakeScheduled || this.closed || this.opts.harness === undefined) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      if (this.busy === undefined && !this.closed) {
        this.busy = this.pass().finally(() => {
          this.busy = undefined;
          if (!this.closed) this.wake();
        });
      }
    });
  }

  /**
   * Stops scheduling and stops the process in flight (Harness Run or
   * verification command). Its Attempt is left as it is; recovery is #13.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([this.currentRun?.cancel(), this.currentProc?.cancel()]);
    await this.busy;
  }

  /** Runs at most one closure or one Attempt. */
  private async pass(): Promise<void> {
    const harness = this.opts.harness;
    if (harness === undefined) return;
    const closure = this.nextClosure();
    if (closure !== undefined) {
      await this.guard(closure.jobId, () => this.runClosure(closure.id, closure.jobId), {
        closureId: closure.id,
      });
      return;
    }
    const claimed = this.claimNext();
    if (claimed === undefined) return;
    await this.guard(claimed.jobId, () => this.runAttempt(harness, claimed.taskId), {
      taskId: claimed.taskId,
    });
  }

  /** Runs `body`; an unexpected error fails the work where it can be seen, never silently. */
  private async guard(
    jobId: string,
    body: () => Promise<void>,
    subject: { taskId?: string; closureId?: string },
  ): Promise<void> {
    try {
      await body();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`task scheduler: ${err instanceof Error ? (err.stack ?? message) : message}`);
      if (this.closed) return;
      try {
        if (subject.taskId !== undefined) this.failTask(jobId, subject.taskId, message);
        if (subject.closureId !== undefined) this.failClosure(jobId, subject.closureId, message);
      } catch (failErr) {
        this.opts.log(`task scheduler: could not record the failure: ${String(failErr)}`);
      }
    }
  }

  // ---- claim ------------------------------------------------------------------

  /**
   * Claims the oldest Job's next ready Task: inserts its lease and moves it
   * `ready → claimed` in one versioned transaction (and starts `execution`).
   */
  private claimNext(): { jobId: string; taskId: string } | undefined {
    const next = this.opts.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.tasks.jobId))
      .innerJoin(
        schema.stageRuns,
        and(
          eq(schema.stageRuns.jobId, schema.tasks.jobId),
          eq(schema.stageRuns.stageId, 'execution'),
        ),
      )
      .where(
        and(
          eq(schema.tasks.state, 'ready'),
          inArray(schema.stageRuns.state, ['queued', 'running']),
        ),
      )
      .orderBy(asc(schema.jobs.createdAt), asc(schema.tasks.priority), asc(sql`"tasks"."rowid"`))
      .limit(1)
      .get();
    if (next === undefined) return undefined;
    const { jobId, id: taskId } = next.task;
    const now = new Date();
    const leaseMs =
      (this.opts.wallClockMs ?? 1_800_000) + (this.opts.verifyTimeoutMs ?? 600_000) * 4 + 60_000;
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = requireTask(tx, taskId, 'ready');
        const leaseId = newId('lse');
        const inserted = tx
          .insert(schema.leases)
          .values({
            resourceKind: 'task',
            resourceId: taskId,
            holder: this.holder,
            leaseId,
            acquiredAt: now.toISOString(),
            heartbeatAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
          })
          .onConflictDoNothing()
          .run();
        if (inserted.changes !== 1) throw new Error(`Task ${taskId} is already leased`);
        stepTask(tx, { jobId, actor: ACTOR }, task, 'claimed', { payload: { leaseId } });
        const execution = state.stageRuns.find((r) => r.stageId === 'execution');
        if (execution?.state === 'queued') step(execution, 'running');
      },
    );
    this.opts.onCommit();
    return { jobId, taskId };
  }

  // ---- an Attempt ----------------------------------------------------------------

  private async runAttempt(harness: AgentHarness, taskId: string): Promise<void> {
    const { db } = this.opts;
    const task = requireTask(db, taskId, 'claimed');
    const definition = TaskDefinitionSchema.parse(JSON.parse(task.definitionJson));
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, task.jobId)).get();
    const repo = db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, task.repositoryId))
      .get();
    if (job === undefined || repo === undefined)
      throw new Error(`Task ${taskId} has no Job or Repository`);

    // The Worktree, from a freshly fetched base, in the Factory Clone only.
    const clone = repo.clonePath;
    await fetchRemote(clone);
    const baseSha =
      (await resolveCommit(clone, `refs/remotes/origin/${repo.defaultBranch}`)) ??
      (await resolveCommit(clone, `refs/heads/${repo.defaultBranch}`));
    if (baseSha === undefined)
      throw new Error(`the Factory Clone has no ${repo.defaultBranch} to start from`);
    const branch = `factory/${job.id}/${task.id}-${task.key}`;
    const path = join(this.opts.workspaceRoot, repo.id, job.id, task.key);
    await excludeResultFile(clone);
    mkdirSync(dirname(path), { recursive: true });
    await addWorktree({ repo: clone, path, branch, startSha: baseSha });

    const worktreeId = newId('wt');
    const attemptId = newId('att');
    const n = 1;
    const wallClockMs = this.opts.wallClockMs ?? 1_800_000;
    const packet = this.packet({ job, task, definition, repo, path, branch, baseSha, wallClockMs });

    const portBase = changeJob(
      db,
      { jobId: job.id, expectedVersion: 'current', actor: ACTOR },
      (tx) => {
        const base = allocatePortBlock(tx, worktreeId, this.holder);
        const now = new Date().toISOString();
        tx.insert(schema.worktrees)
          .values({
            id: worktreeId,
            jobId: job.id,
            taskId,
            repositoryId: repo.id,
            path,
            branch,
            baseSha,
            state: 'active',
            portBase: base,
            createdAt: now,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'worktree',
          entityId: worktreeId,
          jobId: job.id,
          type: 'worktree.created',
          actor: ACTOR,
          payload: { taskId, to: 'active', path, branch, baseSha, portBase: base },
        });
        tx.insert(schema.attempts)
          .values({
            id: attemptId,
            taskId,
            n,
            state: 'running',
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            promptTemplateId: TASK_TEMPLATE_ID,
            promptTemplateHash: TASK_TEMPLATE_HASH,
            packetJson: JSON.stringify(packet),
            worktreeId,
            baseSha,
            commitsJson: '[]',
            protocolViolationsJson: '[]',
            startedAt: now,
            version: 0,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'attempt',
          entityId: attemptId,
          jobId: job.id,
          type: 'attempt.started',
          actor: ACTOR,
          payload: {
            taskId,
            n,
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
            worktreeId,
            baseSha,
          },
        });
        stepTask(
          tx,
          { jobId: job.id, actor: ACTOR },
          requireTask(tx, taskId, 'claimed'),
          'running',
          {
            payload: { attemptId },
          },
        );
        return base;
      },
    );
    this.opts.onCommit();

    const env = guardrailEnv(this.opts.runtimeEnv, {
      FACTORY_JOB_ID: job.id,
      FACTORY_TASK_ID: taskId,
      FACTORY_ATTEMPT_ID: attemptId,
      FACTORY_PORT_BASE: String(portBase),
      PORT: String(portBase),
      CI: 'true',
    });

    const result = await this.harnessRun(harness, {
      jobId: job.id,
      taskId,
      taskKey: task.key,
      attemptId,
      n,
      prompt: renderTaskPrompt(packet),
      cwd: path,
      env,
      wallClockMs,
    });
    if (this.closed) return; // shutdown: left running (recovery is #13)

    this.toVerifying(job.id, taskId, attemptId);

    // Trust nothing the Harness said: read the Worktree and git.
    const inspection = await inspect(path, baseSha);
    const resultContent =
      inspection.result.kind === 'missing'
        ? undefined
        : this.opts.artifacts.writeContent(
            inspection.result.kind === 'valid'
              ? inspection.result.value
              : inspection.result.content,
          );

    let outcome: Outcome;
    let runs: RunRecord[] = [];
    if (result === undefined || result.exit.kind !== 'exited' || result.exit.code !== 0) {
      outcome = {
        state: 'failed',
        exitReason: 'harness_failed',
        detail: `the ${harness.id} Harness Run ${describeExit(result)}`,
      };
    } else if (inspection.result.kind === 'missing') {
      outcome = {
        state: 'failed',
        exitReason: 'invalid_output',
        detail: `[result.missing] no Task Result at ${RESULT_FILE}`,
      };
    } else if (inspection.result.kind === 'invalid') {
      outcome = {
        state: 'failed',
        exitReason: 'invalid_output',
        detail: inspection.result.issues.map((i) => `[${i.rule}] ${i.message}`).join('; '),
      };
    } else if (inspection.result.value.status !== 'done') {
      outcome = {
        state: 'failed',
        exitReason: 'not_done',
        detail: `the Task Result's status is ${inspection.result.value.status}; only done is handled before Phase B`,
      };
    } else {
      const verified = await this.verify(definition, path, env);
      if (verified === undefined) return; // shutdown during verification
      runs = verified;
      const headAfter = await resolveCommit(path, 'HEAD');
      outcome = decide(runs, this.criteriaOf(job.id, definition), headAfter === inspection.headSha);
    }

    this.finish({
      jobId: job.id,
      taskId,
      attemptId,
      worktreeId,
      baseSha,
      inspection,
      resultContent,
      runs,
      outcome,
      usage:
        result === undefined
          ? null
          : { ...result.usage, durationMs: Math.round(result.durationMs) },
    });
  }

  private packet(input: {
    job: typeof schema.jobs.$inferSelect;
    task: TaskRow;
    definition: TaskDefinition;
    repo: typeof schema.repositories.$inferSelect;
    path: string;
    branch: string;
    baseSha: string;
    wallClockMs: number;
  }): TaskPacket {
    const { job, task, definition, repo } = input;
    const artifacts = this.opts.artifacts.listForJob(job.id).filter((a) => a.stageRunId !== null);
    const spec = artifacts.find((a) => a.kind === 'spec');
    const discovery = artifacts.find((a) => a.kind === 'discovery');
    const objective =
      spec === undefined
        ? job.description || job.title
        : SpecificationProposalSchema.parse(this.opts.artifacts.readJson(spec.id)).objective;
    const files =
      discovery === undefined
        ? []
        : DiscoveryProposalSchema.parse(this.opts.artifacts.readJson(discovery.id)).files.map(
            (f) => f.path,
          );
    const criteria = this.criteriaOf(job.id, definition);
    return TaskPacketSchema.parse({
      packetVersion: 1,
      job: { id: job.id, title: job.title, objective },
      task: {
        id: task.id,
        key: task.key,
        title: task.title,
        objective: definition.objective,
        role: definition.role,
        risk: definition.risk,
      },
      repository: {
        id: repo.id,
        name: repo.name,
        worktreePath: input.path,
        baseBranch: repo.defaultBranch,
        baseSha: input.baseSha,
        taskBranch: input.branch,
      },
      scope: {
        writable: definition.scope.writable,
        forbidden: definition.scope.forbidden,
        readHints: definition.scope.readHints,
      },
      acceptance: criteria.map((c) => ({ code: c.code, text: c.text, mandatory: c.mandatory })),
      verification: definition.verification.map((v) => ({
        key: v.key,
        command: v.command,
        required: v.required,
      })),
      context: {
        artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, contentHash: a.contentHash })),
        files,
      },
      limits: { maxTurns: MAX_TURNS, wallClockS: input.wallClockMs / 1000 },
      protocol: { resultFile: RESULT_FILE, mayAskQuestions: false },
    } satisfies TaskPacket);
  }

  /** The Job's Acceptance Criteria the Task covers. */
  private criteriaOf(jobId: string, definition: TaskDefinition) {
    if (definition.acceptance.length === 0) return [];
    return this.opts.db
      .select()
      .from(schema.acceptanceCriteria)
      .where(
        and(
          eq(schema.acceptanceCriteria.jobId, jobId),
          inArray(schema.acceptanceCriteria.code, definition.acceptance),
        ),
      )
      .orderBy(asc(schema.acceptanceCriteria.code))
      .all();
  }

  /** The developer Harness Run, recorded as `harness_run.started` / `.finished` events. */
  private async harnessRun(
    harness: AgentHarness,
    input: {
      jobId: string;
      taskId: string;
      taskKey: string;
      attemptId: string;
      n: number;
      prompt: string;
      cwd: string;
      env: Record<string, string>;
      wallClockMs: number;
    },
  ): Promise<HarnessRawResult | undefined> {
    let started: HarnessRun;
    try {
      started = await harness.start({
        role: 'developer',
        prompt: input.prompt,
        cwd: input.cwd,
        env: input.env,
        subject: { jobId: input.jobId, stageId: 'execution', taskKey: input.taskKey },
        limits: { wallClockMs: input.wallClockMs, maxTurns: MAX_TURNS },
      });
    } catch (err) {
      this.opts.log(`task scheduler: the ${harness.id} Harness did not start: ${String(err)}`);
      return undefined;
    }
    this.currentRun = started;
    this.opts.db.transaction((tx) => {
      if (started.sessionRef !== undefined) {
        tx.update(schema.attempts)
          .set({ sessionRef: started.sessionRef })
          .where(eq(schema.attempts.id, input.attemptId))
          .run();
      }
      appendEvent(tx, {
        entityKind: 'harness_run',
        entityId: started.executionId,
        jobId: input.jobId,
        type: 'harness_run.started',
        actor: ACTOR,
        payload: {
          attemptId: input.attemptId,
          taskId: input.taskId,
          stageId: 'execution',
          role: 'developer',
          harnessId: harness.id,
          n: input.n,
          template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
          ...(started.sessionRef === undefined ? {} : { sessionRef: started.sessionRef }),
          ...(started.pid === undefined ? {} : { pid: started.pid }),
        },
      });
    });
    this.opts.onCommit();
    // Progress isn't stored yet (redaction first, #11), only counted.
    const drained = (async () => {
      let count = 0;
      for await (const event of started.events) if (event.kind !== 'usage') count++;
      return count;
    })();
    const result = await started.result;
    const events = await drained;
    this.currentRun = undefined;
    this.event(input.jobId, 'harness_run', started.executionId, 'harness_run.finished', {
      attemptId: input.attemptId,
      taskId: input.taskId,
      harnessId: harness.id,
      n: input.n,
      exit: result.exit,
      durationMs: result.durationMs,
      events,
      usage: result.usage,
    });
    return result;
  }

  private toVerifying(jobId: string, taskId: string, attemptId: string): void {
    changeJob(this.opts.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      stepAttempt(tx, jobId, attemptId, 'running', { state: 'verifying' });
      stepTask(tx, { jobId, actor: ACTOR }, requireTask(tx, taskId, 'running'), 'verifying', {
        payload: { attemptId },
      });
    });
    this.opts.onCommit();
  }

  /** Runs every verification command in the Worktree, in order, under the guardrail. */
  private async verify(
    definition: TaskDefinition,
    cwd: string,
    env: Record<string, string>,
  ): Promise<RunRecord[] | undefined> {
    const runs: RunRecord[] = [];
    for (const v of definition.verification) {
      const startedAt = new Date().toISOString();
      const proc = spawnGuarded({
        command: 'sh',
        args: ['-c', v.command],
        cwd,
        env,
        timeoutMs: this.opts.verifyTimeoutMs ?? 600_000,
      });
      this.currentProc = proc;
      const exit = await proc.exit;
      this.currentProc = undefined;
      if (this.closed) return undefined;
      const exitCode = exit.timedOut ? null : exit.code;
      runs.push({
        key: v.key,
        command: v.command,
        required: v.required,
        criteria: v.criteria,
        exitCode,
        timedOut: exit.timedOut,
        startedAt,
        durationMs: exit.durationMs,
        content: this.opts.artifacts.writeContent({
          key: v.key,
          command: v.command,
          exitCode,
          timedOut: exit.timedOut,
          truncated: exit.truncated,
          output: exit.output,
        }),
      });
    }
    return runs;
  }

  /**
   * Records everything the factory found, ends the Attempt, moves the Task,
   * releases its lease, preserves the Worktree and settles `execution`. One
   * transaction.
   */
  private finish(input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    worktreeId: string;
    baseSha: string;
    inspection: Inspection;
    resultContent: StoredContent | undefined;
    runs: RunRecord[];
    outcome: Outcome;
    usage: Usage | null;
  }): void {
    const { jobId, taskId, attemptId, inspection, outcome } = input;
    const head = inspection.headSha;
    const base = input.baseSha;
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        if (input.resultContent !== undefined) {
          this.opts.artifacts.record(
            tx,
            { jobId, taskId, attemptId, kind: 'task_result', content: input.resultContent },
            ACTOR,
          );
        }
        const definition = TaskDefinitionSchema.parse(
          JSON.parse(requireTask(tx, taskId, 'verifying').definitionJson),
        );
        const runIds = new Map<string, string>();
        for (const run of input.runs) {
          const log = this.opts.artifacts.record(
            tx,
            { jobId, taskId, attemptId, kind: 'log', content: run.content },
            ACTOR,
          );
          const id = newId('vr');
          runIds.set(run.key, id);
          tx.insert(schema.verificationRuns)
            .values({
              id,
              attemptId,
              commandKey: run.key,
              command: run.command,
              required: run.required,
              headSha: head,
              baseSha: base,
              exitCode: run.exitCode,
              timedOut: run.timedOut,
              startedAt: run.startedAt,
              durationMs: run.durationMs,
              outputArtifactId: log.id,
            })
            .run();
          tx.insert(schema.evidence)
            .values({
              id: newId('evd'),
              attemptId,
              kind: 'verification',
              verificationRunId: id,
              verdict: run.exitCode === 0 ? 'pass' : 'fail',
              detail: run.timedOut
                ? 'timed out'
                : `exit ${String(run.exitCode)}${run.required ? '' : ' (not required)'}`,
              headSha: head,
              baseSha: base,
              artifactId: log.id,
            })
            .run();
        }
        if (input.runs.length > 0) {
          for (const criterion of criteriaIn(tx, jobId, definition)) {
            const verdict = criterionVerdict(
              input.runs.filter((r) => r.criteria.includes(criterion.code)),
            );
            tx.insert(schema.evidence)
              .values({
                id: newId('evd'),
                attemptId,
                kind: 'criterion',
                criterionId: criterion.id,
                verdict: verdict.verdict,
                detail: verdict.detail,
                headSha: head,
                baseSha: base,
              })
              .run();
          }
        }
        const now = new Date().toISOString();
        stepAttempt(
          tx,
          jobId,
          attemptId,
          'verifying',
          {
            state: outcome.state,
            exitReason: outcome.exitReason,
            exitDetail: outcome.detail,
            headSha: head,
            commitsJson: JSON.stringify(inspection.commits),
            wipCommit: inspection.wipCommit,
            protocolViolationsJson: JSON.stringify(inspection.violations),
            usageJson: input.usage === null ? null : JSON.stringify(input.usage),
            finishedAt: now,
          },
          {
            exitReason: outcome.exitReason,
            headSha: head,
            baseSha: base,
            wipCommit: inspection.wipCommit,
          },
        );
        stepTask(
          tx,
          { jobId, actor: ACTOR },
          requireTask(tx, taskId, 'verifying'),
          outcome.state === 'passed' ? 'approved' : 'failed',
          { reason: outcome.exitReason, payload: { attemptId, headSha: head } },
        );
        tx.delete(schema.leases)
          .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
          .run();
        stepWorktree(tx, jobId, requireWorktree(tx, input.worktreeId), 'active', 'preserved');
        settleExecution(tx, state, step);
      },
    );
    this.opts.onCommit();
  }

  /** Fails a Task the factory itself could not carry through (`factory_error`). */
  private failTask(jobId: string, taskId: string, message: string): void {
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
        if (task === undefined) return;
        const attempt = tx
          .select()
          .from(schema.attempts)
          .where(
            and(
              eq(schema.attempts.taskId, taskId),
              inArray(schema.attempts.state, ['running', 'verifying']),
            ),
          )
          .get();
        const detail = `the factory could not run this Task: ${message}`;
        if (attempt !== undefined) {
          stepAttempt(
            tx,
            jobId,
            attempt.id,
            attempt.state as AttemptState,
            {
              state: 'failed',
              exitReason: 'factory_error',
              exitDetail: detail,
              finishedAt: new Date().toISOString(),
            },
            { exitReason: 'factory_error' },
          );
          const worktree = requireWorktree(tx, attempt.worktreeId);
          if (worktree.state === 'active') stepWorktree(tx, jobId, worktree, 'active', 'preserved');
        }
        if (['claimed', 'running', 'verifying'].includes(task.state)) {
          stepTask(tx, { jobId, actor: ACTOR }, task, 'failed', {
            reason: 'factory_error',
            payload: { detail },
          });
        }
        tx.delete(schema.leases)
          .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
          .run();
        settleExecution(tx, state, step);
      },
    );
    this.opts.onCommit();
  }

  // ---- closure ---------------------------------------------------------------------

  private nextClosure(): { id: string; jobId: string } | undefined {
    return this.opts.db
      .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
      .from(schema.stageRuns)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
      .where(and(eq(schema.stageRuns.stageId, 'closure'), eq(schema.stageRuns.state, 'queued')))
      .orderBy(asc(schema.jobs.createdAt))
      .limit(1)
      .get();
  }

  /**
   * Writes the Delivery Report, then removes the Job's Worktrees (their
   * branches stay in the Factory Clone), then completes `closure`. A Worktree
   * that git refuses to remove stays `preserved`.
   */
  private async runClosure(stageRunId: string, jobId: string): Promise<void> {
    const { db } = this.opts;
    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
      step(requireStageRun(state, stageRunId, 'queued'), 'running');
    });
    this.opts.onCommit();

    const report = await buildDeliveryReport(db, jobId);
    const content = this.opts.artifacts.writeContent(report);
    db.transaction(
      (tx) => {
        this.opts.artifacts.record(tx, { jobId, kind: 'report', content }, ACTOR);
      },
      { behavior: 'immediate' },
    );
    this.opts.onCommit();

    // Removal only after delivery: the branches hold the work, the report says where.
    const preserved = db
      .select()
      .from(schema.worktrees)
      .where(and(eq(schema.worktrees.jobId, jobId), eq(schema.worktrees.state, 'preserved')))
      .all();
    for (const worktree of preserved) {
      const repo = db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, worktree.repositoryId))
        .get();
      try {
        if (repo === undefined) throw new Error('no Repository');
        await removeWorktree(repo.clonePath, worktree.path);
      } catch (err) {
        this.event(jobId, 'worktree', worktree.id, 'worktree.remove_failed', {
          path: worktree.path,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
        stepWorktree(tx, jobId, requireWorktree(tx, worktree.id), 'preserved', 'removed');
        tx.delete(schema.leases)
          .where(
            and(
              eq(schema.leases.resourceKind, 'port_block'),
              eq(schema.leases.resourceId, String(worktree.portBase)),
            ),
          )
          .run();
      });
      this.opts.onCommit();
    }

    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
      step(requireStageRun(state, stageRunId, 'running'), 'succeeded');
    });
    this.opts.onCommit();
  }

  private failClosure(jobId: string, stageRunId: string, message: string): void {
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (_, state, step) => {
        const run = state.stageRuns.find((r) => r.id === stageRunId);
        if (run?.state !== 'running') return;
        step(run, 'failed', {
          failure: { reason: 'factory_error', message: `closure failed: ${message}`, issues: [] },
        });
      },
    );
    this.opts.onCommit();
  }

  private event(
    jobId: string,
    entityKind: string,
    entityId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.opts.db.transaction((tx) => {
      appendEvent(tx, { entityKind, entityId, jobId, type, actor: ACTOR, payload });
    });
    this.opts.onCommit();
  }
}

// ---- after the Run -----------------------------------------------------------------

/**
 * What is really in the Worktree: leftovers committed as a flagged WIP commit
 * (never discarded), the head and commits read from git, and the Task Result
 * parsed and checked against git.
 */
async function inspect(worktree: string, baseSha: string): Promise<Inspection> {
  const leftovers = await uncommittedPaths(worktree);
  let wipCommit: string | null = null;
  if (leftovers.length > 0) {
    wipCommit = await commitAll(
      worktree,
      `wip: uncommitted changes left by the Harness\n\n` +
        `The factory committed these so nothing is lost. Review them.\n\n` +
        `Factory-WIP: true\n` +
        leftovers.map((p) => `Factory-WIP-Path: ${p}`).join('\n'),
    );
  }
  const headSha = await resolveCommit(worktree, 'HEAD');
  if (headSha === undefined) throw new Error(`the Worktree ${worktree} has no HEAD`);
  const commits = (await commitsBetween(worktree, baseSha, headSha)).map((c) => c.sha);

  const file = join(worktree, RESULT_FILE);
  let result: Inspection['result'] = { kind: 'missing' };
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      result = {
        kind: 'invalid',
        content: raw,
        issues: [
          {
            rule: 'json',
            message: `the Task Result is not JSON (${err instanceof Error ? err.message : String(err)})`,
          },
        ],
      };
    }
    if (result.kind === 'missing') {
      const parsed = TaskResultSchema.safeParse(json);
      result = parsed.success
        ? { kind: 'valid', value: parsed.data }
        : { kind: 'invalid', content: json, issues: schemaIssues(parsed.error) };
    }
  }
  const violations: RuleIssue[] = [];
  if (result.kind === 'valid') {
    for (const claimed of result.value.commits) {
      const lower = claimed.toLowerCase();
      if (lower.length < 7 || !commits.some((c) => c.startsWith(lower))) {
        violations.push({
          rule: 'result.commits_exist',
          message: `the Task Result lists commit ${claimed}, which is not on the Task Branch (base..head)`,
        });
      }
    }
  }
  return { headSha, commits, wipCommit, result, violations };
}

/**
 * Approval before review exists (#8): every required verification command
 * passed, HEAD did not move during verification, and every mandatory criterion
 * the Task covers has passing Evidence.
 */
function decide(
  runs: readonly RunRecord[],
  criteria: readonly { code: string; mandatory: boolean }[],
  headUnchanged: boolean,
): Outcome {
  const problems: string[] = [];
  for (const run of runs) {
    if (run.required && run.exitCode !== 0) {
      problems.push(
        `verification ${run.key} ${run.timedOut ? 'timed out' : `exited ${String(run.exitCode)}`}`,
      );
    }
  }
  if (!headUnchanged) problems.push('HEAD moved during verification, so the Evidence is stale');
  for (const c of criteria) {
    if (!c.mandatory) continue;
    const verdict: EvidenceVerdict = criterionVerdict(
      runs.filter((r) => r.criteria.includes(c.code)),
    ).verdict;
    if (verdict !== 'pass') problems.push(`mandatory ${c.code} has Evidence ${verdict}, not pass`);
  }
  return problems.length === 0
    ? { state: 'passed', exitReason: 'completed', detail: 'every factory Gate passed' }
    : { state: 'failed', exitReason: 'gates_failed', detail: problems.join('; ') };
}

function describeExit(result: HarnessRawResult | undefined): string {
  if (result === undefined) return 'did not start';
  const { exit } = result;
  if (exit.kind === 'exited') return `exited with code ${String(exit.code)}`;
  if (exit.kind === 'timed_out') return `timed out after ${String(exit.afterMs)} ms`;
  return 'was cancelled';
}

/** Keeps the Task Result file out of every commit, via the Factory Clone's `info/exclude`. */
async function excludeResultFile(clone: string): Promise<void> {
  const exclude = await infoExcludePath(clone);
  const line = `/${dirname(RESULT_FILE)}/`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`);
}

// ---- rows and transitions -------------------------------------------------------------

function requireTask(db: FactoryDb | Tx, id: string, expected: string): TaskRow {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (task?.state !== expected) {
    throw new Error(`Task ${id} is ${String(task?.state)}, not ${expected}`);
  }
  return task;
}

function requireWorktree(tx: Tx, id: string): WorktreeRow {
  const row = tx.select().from(schema.worktrees).where(eq(schema.worktrees.id, id)).get();
  if (row === undefined) throw new Error(`no Worktree ${id}`);
  return row;
}

function requireStageRun(state: JobState, id: string, expected: string) {
  const run = state.stageRuns.find((r) => r.id === id);
  if (run?.state !== expected)
    throw new Error(`Stage Run ${id} is ${String(run?.state)}, not ${expected}`);
  return run;
}

function criteriaIn(tx: Tx, jobId: string, definition: TaskDefinition) {
  if (definition.acceptance.length === 0) return [];
  return tx
    .select()
    .from(schema.acceptanceCriteria)
    .where(
      and(
        eq(schema.acceptanceCriteria.jobId, jobId),
        inArray(schema.acceptanceCriteria.code, definition.acceptance),
      ),
    )
    .orderBy(asc(schema.acceptanceCriteria.code))
    .all();
}

/** Updates an Attempt guarded by its state and version, with its `attempt.<state>` event. */
function stepAttempt(
  tx: Tx,
  jobId: string,
  id: string,
  from: AttemptState,
  values: Partial<typeof schema.attempts.$inferInsert> & { state: AttemptState },
  payload: Record<string, unknown> = {},
): void {
  const row = tx.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (row?.state !== from) throw new Error(`Attempt ${id} is ${String(row?.state)}, not ${from}`);
  const updated = tx
    .update(schema.attempts)
    .set({ ...values, version: sql`${schema.attempts.version} + 1` })
    .where(and(eq(schema.attempts.id, id), eq(schema.attempts.version, row.version)))
    .run();
  if (updated.changes !== 1)
    throw new Error(`Attempt ${id} changed under a versioned Job operation`);
  appendEvent(tx, {
    entityKind: 'attempt',
    entityId: id,
    jobId,
    type: `attempt.${values.state}`,
    actor: ACTOR,
    payload: { taskId: row.taskId, n: row.n, from, to: values.state, ...payload },
  });
}

function stepWorktree(
  tx: Tx,
  jobId: string,
  row: WorktreeRow,
  from: WorktreeState,
  to: WorktreeState,
): void {
  const updated = tx
    .update(schema.worktrees)
    .set({ state: to })
    .where(and(eq(schema.worktrees.id, row.id), eq(schema.worktrees.state, from)))
    .run();
  if (updated.changes !== 1) throw new Error(`Worktree ${row.id} is ${row.state}, not ${from}`);
  appendEvent(tx, {
    entityKind: 'worktree',
    entityId: row.id,
    jobId,
    type: `worktree.${to}`,
    actor: ACTOR,
    payload: { taskId: row.taskId, from, to, path: row.path, branch: row.branch },
  });
}

/** Leases the lowest free block of ports to a Worktree. */
function allocatePortBlock(tx: Tx, worktreeId: string, holder: string): number {
  const used = new Set(
    tx
      .select({ id: schema.leases.resourceId })
      .from(schema.leases)
      .where(eq(schema.leases.resourceKind, 'port_block'))
      .all()
      .map((l) => Number(l.id)),
  );
  for (let i = 0; i < PORT_BLOCKS; i++) {
    const base = PORT_BLOCK_START + i * PORT_BLOCK_SIZE;
    if (used.has(base)) continue;
    const now = new Date().toISOString();
    tx.insert(schema.leases)
      .values({
        resourceKind: 'port_block',
        resourceId: String(base),
        holder: `${holder}/${worktreeId}`,
        leaseId: newId('lse'),
        acquiredAt: now,
        heartbeatAt: now,
        // Held for the Worktree's life; released when it is removed.
        expiresAt: '9999-12-31T23:59:59.999Z',
      })
      .run();
    return base;
  }
  throw new Error('no free port block');
}

/**
 * Ends `execution` once its Tasks have: `failed` if any Task failed (no Rework
 * route exists before #9), `succeeded` (and `closure` queued) when all are approved.
 */
function settleExecution(tx: Tx, state: JobState, step: StageRunStepper): void {
  const execution = state.stageRuns.find((r) => r.stageId === 'execution');
  if (execution?.state !== 'running') return;
  const tasks = tx.select().from(schema.tasks).where(eq(schema.tasks.jobId, state.job.id)).all();
  const failed = tasks.find((t) => t.state === 'failed');
  if (failed !== undefined) {
    step(execution, 'failed', {
      failure: {
        reason: 'task_failed',
        message: `Task ${failed.key} failed, and Rework is not built yet`,
        issues: [],
      },
    });
    return;
  }
  if (tasks.length > 0 && tasks.every((t) => t.state === 'approved')) {
    step(execution, 'succeeded');
    const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
    if (closure !== undefined) step(closure, 'queued');
  }
}
