/**
 * The Fake Harness (ARCHITECTURE §6): a scripted Harness for deterministic
 * runs. It is chosen like any other Harness, through runtime configuration,
 * and the runtime treats its output as untrusted like any other.
 *
 * The script is YAML. For each Stage it lists the responses to give, in order:
 * the first Harness Run of that Stage for a Job gets the first response, a
 * re-prompt gets the second, and so on. Each Job starts from the first
 * response. A Run past the end of the list fails (exit code 1).
 *
 *   version: 1
 *   stages:
 *     triage:
 *       - output: { summary: …, type: feature, risk: low }   # emitted as JSON
 *     specification:
 *       - raw: "not json"                                    # emitted verbatim
 *       - output: { … }
 *       - exitCode: 2                                        # a crashing Run
 *         delayMs: 100                                       # before it ends
 *   tasks:                                                   # developer Harness Runs, by Task key
 *     add-sum:
 *       - steps:                                             # in the Worktree, in order
 *           - write: { path: src/math.ts, content: "…" }
 *           - delete: old.txt
 *           - commit: Add sum()                              # git add --all; git commit
 *           - run: "npm test"                                # sh -c, under the guardrail
 *         result: { status: done, … }                        # written to the result file
 *         # resultRaw: "not json"                            # written verbatim instead
 *         exitCode: 0
 *         delayMs: 0                                         # after the steps, before exiting
 *   reviews:                                                 # reviewer Harness Runs, by Task key
 *     add-sum:
 *       - steps: []                                          # optional, in the Worktree, as above
 *         output: { outcome: approved, … }                   # emitted as JSON (or raw: "…")
 *         exitCode: 0
 *
 * A Task's Harness Runs happen in a child process started under the Tier 0 guardrail
 * (the environment, stdin and working directory the factory chose), so the
 * Fake is contained exactly like a real Harness. The n-th Run of a Task for a
 * Job gets the n-th response, counted separately per Role (developer, reviewer).
 * Every Run is a new Session with its own `sessionRef`; the Fake never resumes one.
 *
 * The Run counts are kept in a state file next to the script (`<script>.runs.json`)
 * when the Fake is given one, so a restarted runtime goes on with the next
 * response instead of the first. A Task's Run can be re-attached after a
 * restart (`reattach`): its child process outlives the runtime (ADR-0012).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StageIdSchema } from '@factory/domain';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type {
  AgentHarness,
  HarnessDetection,
  HarnessEvent,
  HarnessExit,
  HarnessRawResult,
  HarnessReattachInput,
  HarnessRun,
  HarnessStartInput,
} from './index.js';
import { attachGuarded, spawnGuarded, type GuardedProcess } from './guardrail.js';

const FakeResponseSchema = z
  .object({
    /** Any value; the Run's output is its JSON. */
    output: z.unknown().optional(),
    /** The Run's output, verbatim. */
    raw: z.string().optional(),
    exitCode: z.number().int().min(0).max(255).default(0),
    delayMs: z.number().int().min(0).max(600_000).default(0),
  })
  .strict()
  .refine((r) => r.output === undefined || r.raw === undefined, {
    message: 'give either output or raw, not both',
  });
export type FakeResponse = z.infer<typeof FakeResponseSchema>;

const FakeStepSchema = z.union([
  z.object({ write: z.object({ path: z.string().min(1), content: z.string() }).strict() }).strict(),
  z.object({ delete: z.string().min(1) }).strict(),
  z.object({ commit: z.string().min(1) }).strict(),
  z.object({ run: z.string().min(1) }).strict(),
]);

const FakeTaskResponseSchema = z
  .object({
    steps: z.array(FakeStepSchema).default([]),
    /** Any value; written as JSON to the Task Result file. */
    result: z.unknown().optional(),
    /** Written verbatim to the Task Result file. */
    resultRaw: z.string().optional(),
    exitCode: z.number().int().min(0).max(255).default(0),
    delayMs: z.number().int().min(0).max(600_000).default(0),
  })
  .strict()
  .refine((r) => r.result === undefined || r.resultRaw === undefined, {
    message: 'give either result or resultRaw, not both',
  });
export type FakeTaskResponse = z.infer<typeof FakeTaskResponseSchema>;

const FakeReviewResponseSchema = z
  .object({
    steps: z.array(FakeStepSchema).default([]),
    /** Any value; the Run's output is its JSON. */
    output: z.unknown().optional(),
    /** The Run's output, verbatim. */
    raw: z.string().optional(),
    exitCode: z.number().int().min(0).max(255).default(0),
    delayMs: z.number().int().min(0).max(600_000).default(0),
  })
  .strict()
  .refine((r) => r.output === undefined || r.raw === undefined, {
    message: 'give either output or raw, not both',
  });
export type FakeReviewResponse = z.infer<typeof FakeReviewResponseSchema>;

const FakeScriptSchema = z
  .object({
    version: z.literal(1),
    stages: z.partialRecord(StageIdSchema, z.array(FakeResponseSchema).min(1)).default({}),
    tasks: z.record(z.string(), z.array(FakeTaskResponseSchema).min(1)).default({}),
    reviews: z.record(z.string(), z.array(FakeReviewResponseSchema).min(1)).default({}),
  })
  .strict();
export type FakeScript = z.infer<typeof FakeScriptSchema>;

export class FakeScriptError extends Error {
  override readonly name = 'FakeScriptError';
}

/** Parses and validates a script, naming every problem. */
export function parseFakeScript(text: string, source = 'fake script'): FakeScript {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (err) {
    throw new FakeScriptError(
      `${source}: not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = FakeScriptSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new FakeScriptError(`${source}: ${issues}`);
  }
  return parsed.data;
}

export function loadFakeScript(path: string): FakeScript {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new FakeScriptError(
      `cannot read fake script ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseFakeScript(text, path);
}

export class FakeHarness implements AgentHarness {
  readonly id = 'fake';
  readonly capabilities = ['cancel'] as const;
  /** Runs started so far per `job/stage/task/role`, to pick the next response. */
  private readonly runs: Map<string, number>;

  /** `statePath`: where the Run counts are kept across restarts (none: in memory only). */
  constructor(
    private readonly script: FakeScript,
    private readonly statePath?: string,
  ) {
    this.runs = new Map(
      statePath !== undefined && existsSync(statePath)
        ? Object.entries(
            z.record(z.string(), z.number()).parse(JSON.parse(readFileSync(statePath, 'utf8'))),
          )
        : [],
    );
  }

  detect(): Promise<HarnessDetection> {
    return Promise.resolve({
      installed: true,
      version: '1',
      credentials: 'not_required',
      problems: [],
    });
  }

  start(input: HarnessStartInput): Promise<HarnessRun> {
    const taskKey = input.subject.taskKey;
    const key = `${input.subject.jobId}/${input.subject.stageId}/${taskKey ?? ''}/${input.role}`;
    const n = (this.runs.get(key) ?? 0) + 1;
    this.runs.set(key, n);
    if (this.statePath !== undefined) {
      writeFileSync(this.statePath, JSON.stringify(Object.fromEntries(this.runs)));
    }
    if (taskKey !== undefined) {
      const token: RunToken = { review: input.role === 'reviewer', taskKey, n };
      const proc = (args: { workerArg: string | undefined; missing: string }) =>
        spawnGuarded({
          command: process.execPath,
          args:
            args.workerArg === undefined
              ? ['-e', `process.stdout.write(${JSON.stringify(args.missing)}); process.exit(1)`]
              : [WORKER, args.workerArg],
          cwd: input.cwd,
          env: input.env,
          timeoutMs: input.limits.wallClockMs,
          spool: input.spool,
        });
      return Promise.resolve(this.processRun(token, input.limits.wallClockMs, proc));
    }
    const responses = StageIdSchema.safeParse(input.subject.stageId).success
      ? this.script.stages[StageIdSchema.parse(input.subject.stageId)]
      : undefined;
    const response = responses?.[n - 1];
    return Promise.resolve(scriptedRun(input, response, n));
  }

  /** A Task's Run started by an earlier runtime: watched to its end, never started again. */
  reattach(input: HarnessReattachInput): Promise<HarnessRun | undefined> {
    const token = RunTokenSchema.parse(JSON.parse(input.token));
    const proc = attachGuarded({
      spool: input.spool,
      startedAt: input.startedAt,
      timeoutMs: input.limits.wallClockMs,
    });
    if (proc === undefined) return Promise.resolve(undefined);
    return Promise.resolve(this.processRun(token, input.limits.wallClockMs, () => proc));
  }

  /** A developer or reviewer Run of a Task: its scripted response, performed by a guarded process. */
  private processRun(
    token: RunToken,
    wallClockMs: number,
    proc: (args: { workerArg: string | undefined; missing: string }) => GuardedProcess,
  ): HarnessRun {
    const { taskKey, n } = token;
    if (token.review) {
      const response = this.script.reviews[taskKey]?.[n - 1];
      const output =
        response === undefined
          ? ''
          : response.raw !== undefined
            ? response.raw
            : response.output === undefined
              ? ''
              : JSON.stringify(response.output);
      return guardedRun(
        token,
        wallClockMs,
        proc({
          workerArg:
            response === undefined
              ? undefined
              : JSON.stringify({
                  steps: response.steps,
                  exitCode: response.exitCode,
                  delayMs: response.delayMs,
                } satisfies FakeTaskResponse),
          missing:
            response === undefined
              ? exhausted(
                  `${FAKE_SCRIPT_EXHAUSTED} #${String(n)} for the review of task ${taskKey}\n`,
                )
              : '',
        }),
        (exit, processOutput) =>
          exit.kind === 'exited' && exit.code === 0 && response !== undefined
            ? output
            : processOutput,
      );
    }
    const response = this.script.tasks[taskKey]?.[n - 1];
    return guardedRun(
      token,
      wallClockMs,
      proc({
        workerArg: response === undefined ? undefined : JSON.stringify(response),
        missing:
          response === undefined
            ? exhausted(`${FAKE_SCRIPT_EXHAUSTED} #${String(n)} for task ${taskKey}\n`)
            : '',
      }),
      (_exit, processOutput) => processOutput,
    );
  }
}

/** What the Fake needs to re-attach to a Task's Run: which response it was given. */
const RunTokenSchema = z.object({ review: z.boolean(), taskKey: z.string(), n: z.number().int() });
type RunToken = z.infer<typeof RunTokenSchema>;

function scriptedRun(
  input: HarnessStartInput,
  response: FakeResponse | undefined,
  n: number,
): HarnessRun {
  const started = Date.now();
  const output =
    response === undefined
      ? exhausted(`${FAKE_SCRIPT_EXHAUSTED} #${String(n)} for stage ${input.subject.stageId}\n`)
      : response.raw !== undefined
        ? response.raw
        : response.output === undefined
          ? ''
          : JSON.stringify(response.output);
  const exitCode = response === undefined ? 1 : response.exitCode;
  const delayMs = response?.delayMs ?? 0;

  let finish: (exit: HarnessExit) => void = () => undefined;
  const ended = new Promise<HarnessExit>((resolve) => {
    finish = resolve;
  });
  const timer = setTimeout(
    () => {
      finish(
        delayMs > input.limits.wallClockMs
          ? { kind: 'timed_out', afterMs: input.limits.wallClockMs }
          : { kind: 'exited', code: exitCode },
      );
    },
    Math.min(delayMs, input.limits.wallClockMs),
  );

  const result: Promise<HarnessRawResult> = ended.then((exit) => ({
    exit,
    output: exit.kind === 'exited' ? output : '',
    usage: { tag: 'unknown', inputTokens: null, outputTokens: null, costUsd: null },
    durationMs: Date.now() - started,
  }));

  async function* events(): AsyncGenerator<HarnessEvent> {
    const res = await result;
    if (res.output !== '') yield { kind: 'text', text: res.output };
  }

  return {
    executionId: `fake_${randomBytes(8).toString('hex')}`,
    sessionRef: newSessionRef(),
    events: events(),
    result,
    cancel: () => {
      clearTimeout(timer);
      finish({ kind: 'cancelled' });
      return result.then(() => undefined);
    },
  };
}

/**
 * Every message about a script without the response a Run asks for starts
 * with this. Such a Run fails (exit 1), and the message also goes to the
 * runtime's stderr: an exhausted script is a bug in the script, and the test
 * helpers fail any scenario whose runtime logged it.
 */
export const FAKE_SCRIPT_EXHAUSTED = 'fake harness: the script has no response';

function exhausted(message: string): string {
  process.stderr.write(message);
  return message;
}

const WORKER = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

/** A new Session id: every Fake Run starts a fresh Session. */
function newSessionRef(): string {
  return `fake-session_${randomBytes(8).toString('hex')}`;
}

/** A Task's Run, from its guarded process. */
function guardedRun(
  token: RunToken,
  wallClockMs: number,
  proc: GuardedProcess,
  outputOf: (exit: HarnessExit, processOutput: string) => string,
): HarnessRun {
  const result: Promise<HarnessRawResult> = proc.exit.then((e) => {
    const exit: HarnessExit = e.cancelled
      ? { kind: 'cancelled' }
      : e.timedOut
        ? { kind: 'timed_out', afterMs: wallClockMs }
        : { kind: 'exited', code: e.code ?? 128 };
    return {
      exit,
      output: outputOf(exit, e.output),
      usage: { tag: 'unknown', inputTokens: null, outputTokens: null, costUsd: null },
      durationMs: e.durationMs,
    };
  });
  async function* events(): AsyncGenerator<HarnessEvent> {
    const res = await result;
    if (res.output !== '') yield { kind: 'text', text: res.output };
  }
  return {
    executionId: `fake_${randomBytes(8).toString('hex')}`,
    sessionRef: newSessionRef(),
    ...(proc.pid === undefined
      ? {}
      : { pid: proc.pid, process: { pid: proc.pid, token: JSON.stringify(token) } }),
    events: events(),
    result,
    cancel: () => proc.cancel().then(() => undefined),
  };
}
