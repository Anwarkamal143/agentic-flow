/**
 * The pull request (#57, C1, ADR-0036): its body, rendered by plain code from
 * persisted state (never by an LLM), the hidden factory marker it carries, the
 * recovery rule for a PR found on the head branch, and its persisted view.
 * Pure.
 */
import { z } from 'zod';
import type { EvidenceVerdict, ForeignCommit } from './execution.js';
import {
  MergeGateSchema,
  PrCheckSchema,
  type CheckOutcome,
  type GateStatus,
} from './merge-gate.js';
import type { Risk } from './proposals.js';
import type { Redactor } from './redaction.js';
import { factoryMarker } from './pr-feedback.js';

/**
 * The hidden marker in the body of each PR the factory opens for a Job. Recovery
 * adopts a PR only if it carries it, and the poller ignores text with it.
 */
export function pullRequestMarker(jobId: string): string {
  return factoryMarker(jobId, 'pull_request');
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
  /**
   * Commits someone other than the factory pushed to the Integration Branch,
   * which the factory fetched and verified (ADR-0042), newest first. Their
   * subject and author are untrusted.
   */
  foreignCommits: readonly ForeignCommit[];
  /**
   * The factory's approved commits a foreign rewrite a human adopted dropped
   * from the branch (`adopt_rewrite`, ADR-0042), newest first.
   */
  droppedCommits: readonly ForeignCommit[];
  /**
   * The files `headSha` changes against `baseSha`; 0 is an empty delivery,
   * flagged at the top of the body. `null` when not counted.
   */
  changedFiles: number | null;
  /**
   * A multi-repo Job's PRs (ADR-0052, ADR-0066): this PR's Repository and the
   * Delivery Order, each Repository with what it comes after and its current
   * PR (`null` until it opens). `null` in a single-repo Job: no section.
   */
  multiRepository: {
    repository: string;
    order: readonly {
      repository: string;
      after: readonly string[];
      pullRequest: { label: string; url: string; state: PullRequestState } | null;
    }[];
  } | null;
}

/** The PRs of a multi-repo Job are not atomic: said in each PR body and the Delivery Report. */
export const NOT_ATOMIC =
  'The pull requests are not atomic: each is merged on its own, and one can be merged while another is not.';

/** The `## Part of a multi-repository Job` section of a PR body. */
function multiRepositorySection(
  jobId: string,
  multi: NonNullable<PullRequestBodyInput['multiRepository']>,
): string {
  const entries = multi.order.map((r, i) => {
    const after = r.after.length === 0 ? '' : `, after ${r.after.map((a) => code(a)).join(', ')}`;
    const pr =
      r.repository === multi.repository
        ? 'this pull request'
        : r.pullRequest === null
          ? 'no pull request opened yet'
          : `${line(r.pullRequest.label)}${link(r.pullRequest.url, 'link')}, ${r.pullRequest.state}`;
    return `${String(i + 1)}. ${code(r.repository)}${after}: ${pr}`;
  });
  return [
    '## Part of a multi-repository Job',
    `This pull request is one of ${String(multi.order.length)}, one per Repository of Job ${code(jobId)}. **${NOT_ATOMIC}**`,
    `Delivery Order: ${multi.order.map((r) => code(r.repository)).join(' → ')}. Merge them in this order: the Merge Gate of a later Repository waits until the pull requests it comes after have merged.`,
    list(entries),
  ].join('\n\n');
}

/**
 * The flag on an empty delivery: the head changes no files against its base,
 * so merging it changes nothing. The factory delivers it and says so; it
 * never refuses one. Shared by the PR body and the `merge` item.
 */
export function emptyDeliveryNote(headSha: string, baseSha: string): string {
  return `This pull request changes no files: head ${headSha} has the same files as base ${baseSha}, so merging it changes nothing. The factory delivers it anyway and flags it; check whether the Job's change was already on the default branch.`;
}

/** A link GitHub reported, shown only when it is an http(s) URL. */
function link(url: string | null, text = 'details'): string {
  if (url === null || !/^https?:\/\/[^\s()<>]+$/.test(url)) return '';
  return ` ([${text}](${url}))`;
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
    ...(input.changedFiles === 0
      ? [`## No changes\n\n**${emptyDeliveryNote(input.headSha, input.baseSha)}**`]
      : []),
    ...(input.multiRepository === null
      ? []
      : [multiRepositorySection(input.jobId, input.multiRepository)]),
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
    `## Foreign commits\n\n${
      input.foreignCommits.length === 0
        ? 'None.'
        : `Pushed to ${code(input.branch)} by someone other than the factory. The factory fetched them, never overwrote them, and held them to the same Gates as its own: the path-scope Gate, every command and the Integration Review above ran on the head that holds them.\n\n${list(
            input.foreignCommits.map(
              (c) => `${code(c.sha)} by ${code(c.author)}: ${code(c.subject)}`,
            ),
          )}${
            input.droppedCommits.length === 0
              ? ''
              : `\n\nDropped by a rewrite a human approved: these approved commits are no longer on ${code(input.branch)}.\n\n${list(
                  input.droppedCommits.map(
                    (c) => `${code(c.sha)} by ${code(c.author)}: ${code(c.subject)}`,
                  ),
                )}`
          }`
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

/** What a human chose on an `integration_rewrite` Blocker Approval to publish a rebuilt Integration Branch (#65). */
export const IntegrationRewriteRouteSchema = z.enum(['force_push_with_lease', 'new_pr']);
export type IntegrationRewriteRoute = z.infer<typeof IntegrationRewriteRouteSchema>;

/**
 * What the `pull_request` Stage does with the PR it recorded for a Repository
 * (#65, ARCHITECTURE §8.1 and §14, Q25), once the Integration Task's approved
 * head is known. Pure.
 *
 * - `open`: no PR is recorded; the first push, needing no approval (nothing was published).
 * - `none`: the PR already has the head, or is no longer open.
 * - `update`: the head descends from the one the factory pushed: a fast-forward, the PR updated in place.
 * - `needs_approval`: a rebuilt Integration Task (a Replan or a re-specification) whose head does
 *   not descend from the pushed one: publishing it rewrites the PR's branch, so it waits on the
 *   human Blocker `integration_rewrite`. The factory never force-pushes on its own judgment.
 * - `force_push` / `new_pr`: the route a human chose on that Blocker.
 */
export function pullRequestDelivery(input: {
  recorded: { state: PullRequestState; pushedSha: string; taskId: string } | null;
  /** The approved Integration Task, and its approved head. */
  taskId: string;
  headSha: string;
  /** `headSha` holds the recorded `pushedSha` (a push would be a fast-forward). */
  fastForward: boolean;
  /** The route a human chose for this Task's head, if any. */
  rewrite: IntegrationRewriteRoute | null;
}): 'open' | 'none' | 'update' | 'needs_approval' | 'force_push' | 'new_pr' {
  const { recorded } = input;
  if (recorded === null) return 'open';
  if (recorded.state !== 'open' || recorded.pushedSha === input.headSha) return 'none';
  if (recorded.taskId === input.taskId || input.fastForward) return 'update';
  if (input.rewrite === 'force_push_with_lease') return 'force_push';
  if (input.rewrite === 'new_pr') return 'new_pr';
  return 'needs_approval';
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
  /**
   * The files the pushed head changes against its base; 0 flags an empty
   * delivery. `null` for a PR recorded before it was counted.
   */
  changedFiles: z.number().int().nullable(),
  /**
   * The number of the PR the factory opened in its place (`new_pr` on an
   * `integration_rewrite` Blocker, #65), or null while it is the current one.
   */
  replacedByNumber: z.number().int().nullable(),
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
