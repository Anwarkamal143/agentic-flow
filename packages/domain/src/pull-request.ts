/**
 * The pull request (#57, C1, ADR-0036): its body, rendered by plain code from
 * persisted state (never by an LLM), the hidden factory marker it carries, the
 * recovery rule for a PR found on the head branch, and its persisted view.
 * Pure.
 */
import { z } from 'zod';
import type { EvidenceVerdict } from './execution.js';
import {
  MergeGateSchema,
  PrCheckSchema,
  type CheckOutcome,
  type GateStatus,
} from './merge-gate.js';
import type { Risk } from './proposals.js';
import type { Redactor } from './redaction.js';

/**
 * The hidden marker in the body of each PR the factory opens for a Job. Recovery
 * adopts a PR only if it carries it, and the poller ignores text with it.
 */
export function pullRequestMarker(jobId: string): string {
  return `<!-- factory:${jobId}:pull_request -->`;
}

/** `true` when `body` carries the PR marker of `jobId`. */
export function hasFactoryMarker(body: string | null, jobId: string): boolean {
  return body?.includes(pullRequestMarker(jobId)) === true;
}

/** Everything the PR body shows, read from persisted rows (the Integration Task's approved Attempt). */
export interface PullRequestBodyInput {
  jobId: string;
  title: string;
  /** From the current Specification. */
  spec: { problem: string; objective: string };
  /** The Integration Branch, and the integration `(head_sha, base_sha)` everything below is on. */
  branch: string;
  headSha: string;
  baseSha: string;
  /** The Task Branches merged into it, in merge order. */
  merged: readonly { key: string; branch: string }[];
  /** Every Acceptance Criterion of the current Specification, with its current Evidence. */
  criteria: readonly {
    code: string;
    text: string;
    mandatory: boolean;
    verdict: EvidenceVerdict;
    detail: string;
  }[];
  /** The factory's verification commands on the integration head. */
  commands: readonly {
    key: string;
    command: string;
    exitCode: number | null;
    verdict: EvidenceVerdict;
  }[];
  risks: {
    /** The highest Plan Task risk. */
    overall: Risk;
    tasks: readonly { key: string; risk: Risk }[];
    /** The Specification's security considerations. */
    securityConsiderations: readonly string[];
  };
  /** Non-blocking Findings of the approving reviews. */
  findings: readonly { task: string; severity: string; location: string; problem: string }[];
  /** Non-blocking questions an approved Attempt asked that no human answered. */
  questions: readonly { task: string; text: string }[];
  /** The Plan's rollback notes, or `null` when it states none. */
  rollback: string | null;
  /**
   * The Merge Gate's checks condition on the PR head, as the poller last
   * recorded it (#58), with each check; `null` before the first poll.
   */
  ci: {
    status: GateStatus;
    reason: string;
    checks: readonly { name: string; outcome: CheckOutcome; url: string | null }[];
  } | null;
}

/** A link GitHub reported, shown only when it is an http(s) URL. */
function link(url: string | null): string {
  if (url === null || !/^https?:\/\/[^\s()<>]+$/.test(url)) return '';
  return ` ([details](${url}))`;
}

/** One line of a list item: newlines folded, so untrusted text can't open a new section. */
function line(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** Inline code that `text` can't break out of. */
function code(text: string): string {
  const flat = line(text);
  return flat.includes('`') ? `\`\` ${flat} \`\`` : `\`${flat}\``;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? 'None.' : items.map((i) => `- ${i}`).join('\n');
}

/**
 * The PR body: the Specification summary, each Acceptance Criterion with its
 * current Evidence, the commands run on the integration head, the risks, the
 * open non-blocking Findings and Questions, the rollback notes ("None
 * supported." unless the Plan states one) and the hidden marker. `redact` is
 * applied to the whole text before it is returned, so nothing secret is sent.
 */
export function renderPullRequestBody(input: PullRequestBodyInput, redact: Redactor): string {
  const sections = [
    `Opened by the Software Factory for Job ${code(input.jobId)}: ${line(input.title)}. Generated from the factory's records; every result below is the factory's own, on head ${code(input.headSha)} over base ${code(input.baseSha)}.`,
    `## Summary\n\n**Problem.** ${line(input.spec.problem)}\n\n**Objective.** ${line(input.spec.objective)}`,
    `## Acceptance Criteria\n\n${list(
      input.criteria.map(
        (c) =>
          `**${c.code}** (${c.mandatory ? 'mandatory' : 'optional'}): **${c.verdict}**. ${line(c.text)} Evidence: ${line(c.detail)}`,
      ),
    )}`,
    `## Commands run on the integration head\n\nOn ${code(input.headSha)}:\n\n${list(
      input.commands.map(
        (c) =>
          `${code(c.key)} ${code(c.command)}: exit ${c.exitCode === null ? 'none (timed out or did not run)' : String(c.exitCode)}, **${c.verdict}**`,
      ),
    )}`,
    `## Risks\n\nOverall: ${input.risks.overall}.\n\n${list([
      ...input.risks.tasks.map((t) => `Task ${code(t.key)}: ${t.risk}`),
      ...input.risks.securityConsiderations.map((s) => `Security: ${line(s)}`),
    ])}`,
    `## Open non-blocking Findings\n\n${list(
      input.findings.map(
        (f) => `Task ${code(f.task)}, ${f.severity}, ${code(f.location)}: ${line(f.problem)}`,
      ),
    )}`,
    `## Open Questions\n\n${list(
      input.questions.map(
        (q) => `Task ${code(q.task)} (agent-proposed, unanswered): ${line(q.text)}`,
      ),
    )}`,
    `## CI checks\n\n${
      input.ci === null
        ? 'Not read from GitHub yet: the factory polls the checks on the head and updates this section.'
        : `On ${code(input.headSha)}: **${input.ci.status}**: ${line(input.ci.reason)}\n\n${list(
            input.ci.checks.map((c) => `${code(c.name)}: ${c.outcome}${link(c.url)}`),
          )}`
    }`,
    `## Rollback\n\n${input.rollback === null ? 'None supported.' : line(input.rollback)}`,
    `## Branches\n\n${code(input.branch)} merges, \`--no-ff\`, in this order:\n\n${list(
      input.merged.map((m) => `${code(m.key)}: ${code(m.branch)}`),
    )}`,
  ];
  return `${redact(sections.join('\n\n'))}\n\n${pullRequestMarker(input.jobId)}\n`;
}

/** The PR title. */
export function pullRequestTitle(jobTitle: string): string {
  return line(jobTitle).slice(0, 250);
}

/**
 * What to do about the PR found on the head branch before creating one
 * (recovery of a GitHub write, Q28): none → create; one carrying this Job's
 * marker → adopt it (a crash came between creating and recording it); one
 * without → `uncertain`, never adopted (someone else's PR).
 */
export function pullRequestRecovery(
  found: { body: string | null } | null,
  jobId: string,
): 'create' | 'adopt' | 'uncertain' {
  if (found === null) return 'create';
  return hasFactoryMarker(found.body, jobId) ? 'adopt' : 'uncertain';
}

export const PullRequestStateSchema = z.enum(['open', 'closed', 'merged']);
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

/** A pull request as the factory recorded it (`pull_requests`, written only by the runtime). */
export const PullRequestRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  repositoryId: z.string(),
  /** The Integration Task whose branch it is. */
  taskId: z.string(),
  owner: z.string(),
  name: z.string(),
  number: z.number().int(),
  url: z.string(),
  state: PullRequestStateSchema,
  headBranch: z.string(),
  baseBranch: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  /** The last head the factory pushed. */
  pushedSha: z.string(),
  /** `true` when recovery adopted a PR the factory had opened before a crash. */
  adopted: z.boolean(),
  createdAt: z.string(),
  /** When GitHub was last read for it; `null` until the poller (#58) reads it. */
  lastPolledAt: z.string().nullable(),
  /** The merge commit, once the poller saw the PR merged on GitHub. */
  mergeSha: z.string().nullable(),
  /** GitHub's `mergeable_state` as last read. */
  mergeableState: z.string().nullable(),
  /** When the factory first saw the current head: the checks grace window starts here. */
  headSeenAt: z.string().nullable(),
  /** GitHub users whose latest review requests changes. */
  changesRequestedBy: z.array(z.string()),
  /** The Merge Gate the poller last evaluated, and when; `null` before the first poll. */
  gate: MergeGateSchema.nullable(),
  gateEvaluatedAt: z.string().nullable(),
  /** The checks recorded on the current head. */
  checks: z.array(PrCheckSchema),
  version: z.number().int(),
});
export type PullRequestRecord = z.infer<typeof PullRequestRecordSchema>;
