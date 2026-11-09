/**
 * The Harness contract (ARCHITECTURE §6): how the factory drives an AI coding
 * tool. The runtime only ever sees this interface; which Harness it gets is
 * decided by runtime configuration alone.
 */
export { FakeHarness, FakeScriptError, loadFakeScript, parseFakeScript } from './fake.js';
export type { FakeScript, FakeResponse, FakeReviewResponse, FakeTaskResponse } from './fake.js';
export {
  ENV_ALLOWLIST,
  attachGuarded,
  guardrailEnv,
  inspectSpool,
  processStartTime,
  spawnGuarded,
} from './guardrail.js';
export { redactingHarness } from './redacting.js';
export {
  CLAUDE_CODE_FLAGS,
  CLAUDE_CODE_UNLISTED_FLAGS,
  ClaudeCodeHarness,
  claudeCodeArgs,
  findExecutable,
  parseClaudeStream,
  probeClaudeCode,
} from './claude-code.js';
export type { ClaudeCodeOptions, ClaudeCodeProbe, ClaudeStream } from './claude-code.js';
export type { GuardedExit, GuardedOptions, GuardedProcess, SpoolState } from './guardrail.js';

export type HarnessCapability = 'resume' | 'structured_output' | 'cancel';

/** What a Role asks of a Harness Run (GLOSSARY: Role). */
export type { HarnessRole } from '@factory/domain';
import type { CostTag, HarnessRole, ToolPolicy, UsageTag } from '@factory/domain';

/** Login presence only, never a value. `unknown`: the Harness has a login the factory can't check safely. */
export type HarnessCredentials = 'present' | 'absent' | 'not_required' | 'unknown';

/** Whether the Harness is usable. Credentials are reported as presence only, never values. */
export interface HarnessDetection {
  installed: boolean;
  version: string | null;
  credentials: HarnessCredentials;
  /** Why the installed Harness can't be driven (e.g. a CLI flag it lacks). Empty when it can. */
  problems: string[];
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
  /**
   * The Role's Tier 0 tool policy, from the Job's Effective Configuration. A
   * Harness with permission flags turns it into them; it never widens it.
   */
  policy: ToolPolicy;
  /**
   * A directory the runtime owns for this Run's process files (guardrail
   * spool, ADR-0012). A Harness whose Run is a process keeps them there, so a
   * later runtime can re-attach.
   */
  spool: string;
}

/** What a later runtime needs to re-attach to a Run (see {@link AgentHarness.reattach}). */
export interface HarnessReattachInput {
  spool: string;
  /** The Run's `process.token`. */
  token: string;
  /** When the Run started (ms since the epoch): its time limit counts from then. */
  startedAt: number;
  limits: { wallClockMs: number };
}

export type HarnessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'progress'; message: string }
  | { kind: 'usage'; usage: HarnessUsage };

/** How a Harness Run ended (defined in `@factory/domain`, where its log is read). */
export { describeHarnessExit, type HarnessExit } from '@factory/domain';
import type { HarnessExit } from '@factory/domain';

/** Usage as the Harness reported it, tagged with how much it can be trusted (ARCHITECTURE §13). */
export interface HarnessUsage {
  /** The trust of the token counts. */
  tag: UsageTag;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** The trust of `costUsd`; `tag` when absent. */
  costTag?: CostTag;
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
  /** The process id (and group id), when the Run is a process. */
  readonly pid?: number;
  /**
   * Set when the Run is a process that can outlive the runtime: its pid and
   * an opaque token the Harness needs to re-attach. The runtime stores both.
   */
  readonly process?: { pid: number; token: string };
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
  /**
   * Re-attaches to a Run a previous runtime started (ADR-0012): the returned
   * Run settles when the process is gone, with what it left. `undefined` when
   * there is nothing to attach to. Never starts a process.
   */
  reattach?(input: HarnessReattachInput): Promise<HarnessRun | undefined>;
  /** Continues a Session with a new message. Not used in Phase A. */
  resume?(
    sessionRef: string,
    message: string,
    opts: Omit<HarnessStartInput, 'prompt'>,
  ): Promise<HarnessRun>;
}
