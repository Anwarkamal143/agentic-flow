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
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StageIdSchema } from '@factory/domain';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type {
  AgentHarness,
  HarnessDetection,
  HarnessEvent,
  HarnessExit,
  HarnessRawResult,
  HarnessRun,
  HarnessStartInput,
} from './index.js';

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

const FakeScriptSchema = z
  .object({
    version: z.literal(1),
    stages: z.partialRecord(StageIdSchema, z.array(FakeResponseSchema).min(1)).default({}),
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
  /** Runs started so far per `job/stage`, to pick the next response. */
  private readonly runs = new Map<string, number>();

  constructor(private readonly script: FakeScript) {}

  detect(): Promise<HarnessDetection> {
    return Promise.resolve({ installed: true, version: '1', credentials: 'not_required' });
  }

  start(input: HarnessStartInput): Promise<HarnessRun> {
    const key = `${input.subject.jobId}/${input.subject.stageId}`;
    const n = (this.runs.get(key) ?? 0) + 1;
    this.runs.set(key, n);
    const responses = StageIdSchema.safeParse(input.subject.stageId).success
      ? this.script.stages[StageIdSchema.parse(input.subject.stageId)]
      : undefined;
    const response = responses?.[n - 1];
    return Promise.resolve(scriptedRun(input, response, n));
  }
}

function scriptedRun(
  input: HarnessStartInput,
  response: FakeResponse | undefined,
  n: number,
): HarnessRun {
  const started = Date.now();
  const output =
    response === undefined
      ? `fake harness: the script has no response #${String(n)} for stage ${input.subject.stageId}\n`
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
    events: events(),
    result,
    cancel: () => {
      clearTimeout(timer);
      finish({ kind: 'cancelled' });
      return result.then(() => undefined);
    },
  };
}
