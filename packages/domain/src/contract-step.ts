/**
 * The contract step as a follow-up Job (ADR-0052, #110). The planner marks
 * the Tasks that remove the old interface `deferred`: they never run in the
 * Job. The Delivery Report lists them as the pending contract step, and once
 * every Repository's pull request has merged (in Delivery Order) an Approval
 * offers a follow-up Job carrying them as its description. No I/O.
 */
import { z } from 'zod';
import type { ApprovalOption } from './approvals.js';
import type { RepositoryDeliveryStatus } from './execution.js';

/** The Delivery Report's pending contract step (v7, optional; #110). */
export const ContractStepSchema = z.object({
  /** Always `pending` when the report is written: the step is another Job's. */
  status: z.literal('pending'),
  /** The Repositories (by name) the deferred Tasks change, by name. */
  repositories: z.array(z.string()),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      /** Its Repository, by name. */
      repository: z.string(),
      objective: z.string(),
      dependsOn: z.array(z.string()),
      acceptance: z.array(z.string()),
    }),
  ),
  line: z.string(),
});
export type ContractStep = z.infer<typeof ContractStepSchema>;

interface DeferrableTask {
  key: string;
  title: string;
  objective: string;
  /** Its Repository, by id or name. */
  repository: string;
  dependsOn: readonly string[];
  acceptance: readonly string[];
  deferred: boolean;
}

/**
 * The Plan's deferred Tasks as the pending contract step, in Plan order, or
 * `null` when the Plan defers nothing. Pure.
 */
export function contractStep(
  tasks: readonly DeferrableTask[],
  repositories: readonly { id: string; name: string }[],
): ContractStep | null {
  const deferred = tasks.filter((t) => t.deferred);
  if (deferred.length === 0) return null;
  const nameOf = (ref: string) =>
    repositories.find((r) => r.id === ref || r.name === ref)?.name ?? ref;
  const listed = deferred.map((t) => ({
    key: t.key,
    title: t.title,
    repository: nameOf(t.repository),
    objective: t.objective,
    dependsOn: [...t.dependsOn],
    acceptance: [...t.acceptance],
  }));
  const names = listed.map((t) => `${t.key} (${t.repository})`).join(', ');
  return {
    status: 'pending',
    repositories: [...new Set(listed.map((t) => t.repository))].sort(),
    tasks: listed,
    line: `contract step pending: Task${listed.length === 1 ? '' : 's'} ${names} ${listed.length === 1 ? 'was' : 'were'} deferred by the Plan and did not run in this Job`,
  };
}

/**
 * Whether the follow-up is offered: only once every Repository of the Job has
 * a merged pull request. A local delivery is never seen merged, so it is
 * never offered. Pure.
 */
export function contractJobOffered(statuses: readonly RepositoryDeliveryStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === 'merged');
}

/** The options of a `contract_job` item. */
export const CONTRACT_JOB_OPTIONS: readonly ApprovalOption[] = [
  {
    id: 'start_job',
    label: 'Start the contract Job',
    description:
      'Create a new Job for the deferred Tasks, with them as its description. It is triaged, planned and approved like any other Job.',
    agentProposed: false,
  },
  {
    id: 'decline',
    label: 'Not now',
    description:
      'Create no Job. The contract step stays listed as pending in the Delivery Report; you can create the Job yourself later.',
    agentProposed: false,
  },
];

/** What a `contract_job` item asks, and why. Pure. */
export function contractJobItemText(step: ContractStep): { question: string; why: string } {
  const repos = step.repositories;
  const listed =
    repos.length <= 1 ? (repos[0] ?? '') : `${repos.slice(0, -1).join(', ')} and ${repos.at(-1)}`;
  return {
    question: `Start the contract Job for ${listed}?`,
    why: `Every pull request of this Job has merged in Delivery Order, so its consumers have migrated. Its Plan deferred the contract step (removing the old interface): ${step.tasks
      .map((t) => `Task ${t.key} (${t.repository}): ${t.title}`)
      .join('; ')}. Starting it creates a new Job with these Tasks as its description; it is planned and approved like any other Job.`,
  };
}

/** The Job title limit (`CreateJobInputSchema`). */
const TITLE_MAX = 200;

/**
 * The follow-up Job a human's `start_job` creates: the contract Repositories
 * (by name), and the deferred Tasks as its description, each criterion with
 * its text from the Job's Specification when known. Pure.
 */
export function contractJobRequest(
  job: { id: string; title: string },
  step: ContractStep,
  criteria: readonly { code: string; text: string }[],
): { title: string; repositories: string[]; description: string } {
  const textOf = (code: string) => {
    const text = criteria.find((c) => c.code === code)?.text;
    return text === undefined ? code : `${code} ${text}`;
  };
  const lines = [
    `The contract step of Job ${job.id} (${job.title}): its Plan deferred these Tasks until every pull request had merged, and every one has.`,
    '',
  ];
  for (const t of step.tasks) {
    lines.push(`- Task ${t.key} (${t.repository}): ${t.title}`, `  Objective: ${t.objective}`);
    if (t.dependsOn.length > 0) {
      lines.push(`  After (done in Job ${job.id}): ${t.dependsOn.join(', ')}`);
    }
    if (t.acceptance.length > 0) {
      lines.push(`  Acceptance: ${t.acceptance.map(textOf).join('; ')}`);
    }
  }
  return {
    title: `Contract step: ${job.title}`.slice(0, TITLE_MAX),
    repositories: [...step.repositories],
    description: lines.join('\n'),
  };
}
