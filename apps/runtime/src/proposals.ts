/**
 * The proposal Stages (PRODUCT_SPEC §4): what each asks its Harness Run for,
 * how the answer is validated, and the versioned prompt template that asks.
 */
import { createHash } from 'node:crypto';
import {
  DiscoveryProposalSchema,
  PlanProposalSchema,
  SpecificationProposalSchema,
  TriageProposalSchema,
  validatePlan,
  validateSpecification,
  type ArtifactKind,
  type PlanContext,
  type RuleIssue,
  type StageId,
} from '@factory/domain';
import type { HarnessRole } from '@factory/harness';
import { z } from 'zod';

export interface ProposalStage {
  readonly stageId: StageId;
  readonly role: HarnessRole;
  readonly kind: ArtifactKind;
  readonly schema: z.ZodType;
  /** What the Role is asked to produce. */
  readonly ask: string;
  /** The code checks run after the schema passes. */
  validate(value: unknown, ctx: PlanContext): RuleIssue[];
}

export const PROPOSAL_STAGES: readonly ProposalStage[] = [
  {
    stageId: 'triage',
    role: 'triager',
    kind: 'triage',
    schema: TriageProposalSchema,
    ask: 'Triage the Job: summarise it, and classify its type and risk.',
    validate: () => [],
  },
  {
    stageId: 'discovery',
    role: 'researcher',
    kind: 'discovery',
    schema: DiscoveryProposalSchema,
    ask: 'Inspect the Repository (read only; change nothing) and report the files relevant to the Job, each with the reason it matters.',
    validate: () => [],
  },
  {
    stageId: 'specification',
    role: 'specifier',
    kind: 'spec',
    schema: SpecificationProposalSchema,
    ask: 'Write a testable Specification. Number Acceptance Criteria AC-01, AC-02, …; mark each mandatory or optional, and say how each is verified. At least one must be mandatory.',
    validate: (value) => validateSpecification(SpecificationProposalSchema.parse(value)),
  },
  {
    stageId: 'planning',
    role: 'planner',
    kind: 'plan',
    schema: PlanProposalSchema,
    ask: "Plan the work as Tasks. Each Task is one coherent change in one of the Job's Repositories, with writable and forbidden path globs relative to the Repository root, its dependencies, the Acceptance Criteria it covers, and the commands that verify it. Tasks that no dependency path orders may run in parallel, so their writable paths must not overlap. Give each Task a priority (low, normal or high); a Task's maxAttempts may only lower the configured limit.",
    validate: (value, ctx) => validatePlan(PlanProposalSchema.parse(value), ctx),
  },
];

export function proposalStage(stageId: string): ProposalStage | undefined {
  return PROPOSAL_STAGES.find((s) => s.stageId === stageId);
}

export const PROPOSAL_STAGE_IDS: readonly StageId[] = PROPOSAL_STAGES.map((s) => s.stageId);

export interface PromptInput {
  job: { id: string; title: string; description: string };
  repositories: readonly { id: string; name: string }[];
  /** Earlier proposal Artifacts of the Job, by kind. */
  inputs: readonly { kind: ArtifactKind; content: unknown }[];
  /** Set on the re-prompt: why the previous output was rejected. */
  rejected?: readonly RuleIssue[];
}

export const PROMPT_TEMPLATE_ID = 'proposal-stage@1';

const TEMPLATE = `You are the {{role}} for a software Job in an automated software factory.
{{ask}}

Job {{jobId}}: {{title}}
{{description}}

Repositories: {{repositories}}

Earlier outputs of this Job (JSON, by kind):
{{inputs}}
{{rejected}}
Reply with exactly one JSON object and nothing else. It must match this JSON Schema:
{{schema}}
`;

/** Hash of the template text, recorded with each Harness Run. */
export const PROMPT_TEMPLATE_HASH = `sha256:${createHash('sha256').update(TEMPLATE).digest('hex')}`;

export function renderPrompt(stage: ProposalStage, input: PromptInput): string {
  const rejected =
    input.rejected === undefined
      ? ''
      : `\nYour previous output was rejected. Fix every problem below:\n${input.rejected
          .map((i) => `- [${i.rule}] ${i.message}`)
          .join('\n')}\n`;
  const values: Record<string, string> = {
    role: stage.role,
    ask: stage.ask,
    jobId: input.job.id,
    title: input.job.title,
    description: input.job.description === '' ? '(no description)' : input.job.description,
    repositories: input.repositories.map((r) => `${r.name} (${r.id})`).join(', '),
    inputs:
      input.inputs.length === 0
        ? '(none)'
        : input.inputs.map((i) => `${i.kind}: ${JSON.stringify(i.content)}`).join('\n'),
    rejected,
    schema: JSON.stringify(z.toJSONSchema(stage.schema, { io: 'input' })),
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
