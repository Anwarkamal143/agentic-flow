/**
 * The Harness contract (ARCHITECTURE §6): how the factory drives an AI coding
 * tool. The runtime only ever sees this interface; which Harness it gets is
 * decided by runtime configuration alone.
 */
export { FakeHarness, FakeScriptError, loadFakeScript, parseFakeScript } from './fake.js';
export type { FakeScript, FakeResponse, FakeTaskResponse } from './fake.js';
export { ENV_ALLOWLIST, guardrailEnv, spawnGuarded } from './guardrail.js';
export type { GuardedExit, GuardedOptions, GuardedProcess } from './guardrail.js';

export type HarnessCapability = 'resume' | 'structured_output' | 'cancel';

/** What a Role asks of a Harness Run (GLOSSARY: Role). */
export type HarnessRole =
  'triager' | 'researcher' | 'specifier' | 'planner' | 'developer' | 'reviewer';

/** Whether the Harness is usable. Credentials are reported as presence only, never values. */
export interface HarnessDetection {
  installed: boolean;
  version: string | null;
  credentials: 'present' | 'absent' | 'not_required';
}

export interface HarnessStartInput {
  role: HarnessRole;
  /** The fully rendered prompt. */
  prompt: string;
  /** Working directory of the Run: a Worktree, or the Factory Clone for proposals. */
  cwd: string;
  /**
   * The complete environment of every process the Run starts (Tier 0
   * guardrail, built by `guardrailEnv`). A Harness never adds the runtime's
   * own environment to it.
   */
  env: Readonly<Record<string, string>>;
  /**
   * What the Run is for. A Harness may use it to name logs or Sessions, or to
   * pick a scripted response (Fake). It never grants anything.
   */
  subject: { jobId: string; stageId: string; taskKey?: string };
  limits: { wallClockMs: number; maxTurns?: number };
}

export type HarnessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'progress'; message: string }
  | { kind: 'usage'; usage: HarnessUsage };

/** How the Run ended. Exit code 0 is not evidence that the output is valid. */
export type HarnessExit =
  { kind: 'exited'; code: number } | { kind: 'cancelled' } | { kind: 'timed_out'; afterMs: number };

/** Usage as the Harness reported it, tagged with how much it can be trusted (ARCHITECTURE §13). */
export interface HarnessUsage {
  tag: 'actual' | 'estimated' | 'unknown';
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface HarnessRawResult {
  exit: HarnessExit;
  /** The final text the Harness produced (for proposals: the JSON to validate). */
  output: string;
  usage: HarnessUsage;
  durationMs: number;
}

/** One started Harness Run. */
export interface HarnessRun {
  readonly executionId: string;
  /** The Harness's own Session id, when it has Sessions. */
  readonly sessionRef?: string;
  /** The process id, when the Run is a child process (for recovery, #13). */
  readonly pid?: number;
  readonly events: AsyncIterable<HarnessEvent>;
  readonly result: Promise<HarnessRawResult>;
  /** Stops the Run. `result` then settles with exit `cancelled`. */
  cancel(): Promise<void>;
}

export interface AgentHarness {
  /** `fake`, `claude-code`, … */
  readonly id: string;
  readonly capabilities: readonly HarnessCapability[];
  detect(): Promise<HarnessDetection>;
  start(input: HarnessStartInput): Promise<HarnessRun>;
  /** Continues a Session with a new message. Not used in Phase A. */
  resume?(
    sessionRef: string,
    message: string,
    opts: Omit<HarnessStartInput, 'prompt'>,
  ): Promise<HarnessRun>;
}
