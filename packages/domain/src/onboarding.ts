/**
 * The onboarding wizard (#114, ADR-0053, ADR-0074): its steps, the policy
 * presets, and the checks that must pass to finish. Pure. The wizard's only
 * state is the last step completed; every step's configuration is written
 * through the runtime's ordinary APIs, never held as a draft.
 */
import { z } from 'zod';
import { BillingSchema } from './billing.js';
import { PlanApprovalPolicySchema } from './config-levels.js';
import { MergePolicySchema } from './merge-gate.js';

export const ONBOARDING_STEPS = [
  'basics',
  'harnesses',
  'github',
  'project',
  'preset',
  'concurrency',
  'verification',
] as const;
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

/** `GET /v1/onboarding`. */
export const OnboardingSchema = z.object({
  steps: z.array(OnboardingStepSchema),
  /** The last step completed; `null` before the first. The wizard's only state. */
  lastCompleted: OnboardingStepSchema.nullable(),
  /** The first step not completed (where resume opens); `null` once finished. */
  next: OnboardingStepSchema.nullable(),
  finished: z.boolean(),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type Onboarding = z.infer<typeof OnboardingSchema>;

/** `POST /v1/onboarding/complete`: Next (or Finish) on a step. */
export const CompleteOnboardingStepInputSchema = z.object({
  step: OnboardingStepSchema,
  /** When given, refused unless the wizard is at this version. */
  expectedVersion: z.number().int().min(1).optional(),
});
export type CompleteOnboardingStepInput = z.infer<typeof CompleteOnboardingStepInputSchema>;

/** The first step not completed after `lastCompleted`, or `null` when every step is. */
export function nextOnboardingStep(lastCompleted: OnboardingStep | null): OnboardingStep | null {
  const index = lastCompleted === null ? -1 : ONBOARDING_STEPS.indexOf(lastCompleted);
  return ONBOARDING_STEPS[index + 1] ?? null;
}

export type StepCompletion =
  | { ok: true; lastCompleted: OnboardingStep }
  | { ok: false; code: 'onboarding_step_out_of_order'; message: string };

/**
 * Completing `step`: the first step not completed moves the wizard on; an
 * earlier one (the human went back) keeps the furthest step; a later one is
 * refused, so no step is skipped.
 */
export function completeOnboardingStep(
  lastCompleted: OnboardingStep | null,
  step: OnboardingStep,
): StepCompletion {
  const done = lastCompleted === null ? -1 : ONBOARDING_STEPS.indexOf(lastCompleted);
  const at = ONBOARDING_STEPS.indexOf(step);
  if (at <= done && lastCompleted !== null) return { ok: true, lastCompleted };
  if (at === done + 1) return { ok: true, lastCompleted: step };
  return {
    ok: false,
    code: 'onboarding_step_out_of_order',
    message: `step '${step}' comes after '${String(nextOnboardingStep(lastCompleted))}', which is not completed yet`,
  };
}

// ---- Policy presets (ADR-0053) ----------------------------------------------

export const PolicyPresetIdSchema = z.enum([
  'manual',
  'assisted',
  'controlled_autonomy',
  'advanced',
]);
export type PolicyPresetId = z.infer<typeof PolicyPresetIdSchema>;

export interface PolicyPreset {
  id: PolicyPresetId;
  label: string;
  description: string;
  /** Controlled autonomy is shown but can't be chosen until `auto_if_low_risk_and_green` exists. */
  available: boolean;
  default: boolean;
}

export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: 'manual',
    label: 'Manual',
    description:
      'Every Plan waits for your approval, the factory never merges (never_auto), and one Task runs at a time (concurrency.global 1).',
    available: true,
    default: false,
  },
  {
    id: 'assisted',
    label: 'Assisted',
    description:
      'Every Plan waits for your approval and the factory never merges (never_auto); you merge each pull request.',
    available: true,
    default: true,
  },
  {
    id: 'controlled_autonomy',
    label: 'Controlled autonomy',
    description:
      'Merges low-risk, green pull requests itself: not available yet (it needs the auto_if_low_risk_and_green Merge Policy, Phase E).',
    available: false,
    default: false,
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description:
      'Choose plan approval and the Merge Policy ceiling field by field; human_approval lets a Repository ask the factory to merge after your approval.',
    available: true,
    default: false,
  },
];

/** `POST /v1/factory/config/preset`. `planApproval` and `mergePolicy`: Advanced only. */
export const ApplyPresetInputSchema = z.object({
  preset: PolicyPresetIdSchema,
  planApproval: PlanApprovalPolicySchema.optional(),
  mergePolicy: MergePolicySchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
});
export type ApplyPresetInput = z.infer<typeof ApplyPresetInputSchema>;

/** One Factory Level key to set, dotted when nested. */
export const FactoryConfigChangeSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});
export type FactoryConfigChange = z.infer<typeof FactoryConfigChangeSchema>;

/** `POST /v1/factory/config/set-many`: several keys in one change, all or none. */
export const SetFactoryConfigManyInputSchema = z.object({
  changes: z.array(FactoryConfigChangeSchema).min(1).max(20),
  expectedVersion: z.number().int().min(1).optional(),
});
export type SetFactoryConfigManyInput = z.infer<typeof SetFactoryConfigManyInputSchema>;

export type PresetChanges =
  | { ok: true; changes: FactoryConfigChange[] }
  | { ok: false; code: 'preset_not_available' | 'invalid_request'; message: string };

/** The Factory Level keys a preset sets (ADR-0053); keys it doesn't name are left as they are. */
export function presetChanges(
  input: Pick<ApplyPresetInput, 'preset' | 'planApproval' | 'mergePolicy'>,
): PresetChanges {
  const strict = [
    { key: 'planApproval', value: 'required' },
    { key: 'mergePolicy', value: 'never_auto' },
  ];
  switch (input.preset) {
    case 'manual':
      return { ok: true, changes: [...strict, { key: 'concurrency.global', value: 1 }] };
    case 'assisted':
      return { ok: true, changes: strict };
    case 'controlled_autonomy':
      return {
        ok: false,
        code: 'preset_not_available',
        message:
          'Controlled autonomy is not available yet: it needs the auto_if_low_risk_and_green Merge Policy (Phase E, spec issue 47)',
      };
    case 'advanced':
      if (input.planApproval === undefined || input.mergePolicy === undefined) {
        return {
          ok: false,
          code: 'invalid_request',
          message: 'the Advanced preset needs planApproval and mergePolicy',
        };
      }
      return {
        ok: true,
        changes: [
          { key: 'planApproval', value: input.planApproval },
          { key: 'mergePolicy', value: input.mergePolicy },
        ],
      };
  }
}

// ---- Finish checks ----------------------------------------------------------

export const OnboardingCheckSchema = z.object({
  id: z.enum(['node', 'git', 'claude', 'claude_login', 'repository']),
  label: z.string(),
  /** `fail` blocks Finish; `warning` does not. */
  status: z.enum(['pass', 'fail', 'warning']),
  message: z.string(),
});
export type OnboardingCheck = z.infer<typeof OnboardingCheckSchema>;

/** `GET /v1/onboarding/checks`. */
export const OnboardingChecksSchema = z.object({
  checks: z.array(OnboardingCheckSchema),
  /** No check fails. */
  canFinish: z.boolean(),
});
export type OnboardingChecks = z.infer<typeof OnboardingChecksSchema>;

type ToolStatus = 'ok' | 'missing' | 'failed';

/** What the checks read: doctor's tool statuses and login, and the Repository count. */
export interface OnboardingCheckInput {
  tools: { node: ToolStatus; git: ToolStatus; claude: ToolStatus };
  /** `claude auth status` by its exit code; `null` when it could not be detected safely. */
  claudeLogin: boolean | null;
  /** The configured Claude Code Harness's billing; `null` when another Harness is configured. */
  billing: z.infer<typeof BillingSchema> | null;
  repositories: number;
}

const TOOL_LABELS = { node: 'Node.js', git: 'git', claude: 'Claude Code' } as const;

/**
 * The checks Finish needs (ADR-0053): node, git and Claude Code present, and a
 * Repository registered. Claude Code's login fails only when it was detected
 * as logged out; when it can't be detected safely it is a warning, and with
 * API-key billing it isn't needed.
 */
export function onboardingChecks(input: OnboardingCheckInput): OnboardingCheck[] {
  const tools = (['node', 'git', 'claude'] as const).map((id): OnboardingCheck => {
    const status = input.tools[id];
    const label = TOOL_LABELS[id];
    return {
      id,
      label,
      status: status === 'ok' ? 'pass' : 'fail',
      message:
        status === 'ok'
          ? `${label} is installed`
          : status === 'missing'
            ? `${label} was not found on the runtime's PATH; see factory doctor for the fix`
            : `${label} was found but can't be used; see factory doctor for why`,
    };
  });
  const login: OnboardingCheck =
    input.billing === 'api_key'
      ? {
          id: 'claude_login',
          label: 'Claude Code login',
          status: 'pass',
          message: 'Not needed: Claude Code is billed to an API key (ANTHROPIC_API_KEY)',
        }
      : input.claudeLogin === true
        ? {
            id: 'claude_login',
            label: 'Claude Code login',
            status: 'pass',
            message: 'Claude Code reports a login',
          }
        : input.claudeLogin === false
          ? {
              id: 'claude_login',
              label: 'Claude Code login',
              status: 'fail',
              message: 'Claude Code reports no login: run `claude` and log in, then check again',
            }
          : {
              id: 'claude_login',
              label: 'Claude Code login',
              status: 'warning',
              message:
                'Claude Code’s login could not be detected safely; Harness Runs fail until it has one',
            };
  const repository: OnboardingCheck = {
    id: 'repository',
    label: 'A registered Repository',
    status: input.repositories > 0 ? 'pass' : 'fail',
    message:
      input.repositories > 0
        ? `${String(input.repositories)} registered`
        : 'No Repository is registered: add one in the Project and Repository step',
  };
  return [...tools, login, repository];
}
