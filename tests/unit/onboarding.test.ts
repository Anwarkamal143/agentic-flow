/**
 * The onboarding wizard's rules (#114, ADR-0053, ADR-0074): the step order and
 * resume, the policy presets, and the finish checks. Pure; tested through
 * `@factory/domain`.
 */
import {
  completeOnboardingStep,
  nextOnboardingStep,
  onboardingChecks,
  ONBOARDING_STEPS,
  POLICY_PRESETS,
  presetChanges,
  type OnboardingCheckInput,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const READY: OnboardingCheckInput = {
  tools: { node: 'ok', git: 'ok', claude: 'ok' },
  claudeLogin: true,
  billing: 'subscription',
  repositories: 1,
};

describe('the onboarding steps', () => {
  it('are basics, harnesses, GitHub, Project and Repository, preset, concurrency, verification', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'basics',
      'harnesses',
      'github',
      'project',
      'preset',
      'concurrency',
      'verification',
    ]);
  });

  it('resume at the first step not completed, and none once the last is', () => {
    expect(nextOnboardingStep(null)).toBe('basics');
    expect(nextOnboardingStep('github')).toBe('project');
    expect(nextOnboardingStep('verification')).toBeNull();
  });

  it('complete in order: the next step moves on, an earlier one changes nothing', () => {
    expect(completeOnboardingStep(null, 'basics')).toEqual({ ok: true, lastCompleted: 'basics' });
    expect(completeOnboardingStep('preset', 'concurrency')).toEqual({
      ok: true,
      lastCompleted: 'concurrency',
    });
    // Going back and pressing Next again keeps the furthest step.
    expect(completeOnboardingStep('preset', 'github')).toEqual({
      ok: true,
      lastCompleted: 'preset',
    });
  });

  it('refuse a step past the first one not completed, naming it', () => {
    const skip = completeOnboardingStep('basics', 'project');
    expect(skip.ok).toBe(false);
    if (skip.ok) return;
    expect(skip.code).toBe('onboarding_step_out_of_order');
    expect(skip.message).toContain("'harnesses'");
  });
});

describe('the policy presets', () => {
  it('offer Manual, Assisted (the default), Controlled autonomy (not available yet) and Advanced', () => {
    expect(POLICY_PRESETS.map((p) => [p.id, p.available, p.default])).toEqual([
      ['manual', true, false],
      ['assisted', true, true],
      ['controlled_autonomy', false, false],
      ['advanced', true, false],
    ]);
    const controlled = POLICY_PRESETS.find((p) => p.id === 'controlled_autonomy');
    expect(controlled?.description).toContain('not available yet');
  });

  it('Manual: plan approval required, never_auto, one Task at a time', () => {
    expect(presetChanges({ preset: 'manual' })).toEqual({
      ok: true,
      changes: [
        { key: 'planApproval', value: 'required' },
        { key: 'mergePolicy', value: 'never_auto' },
        { key: 'concurrency.global', value: 1 },
      ],
    });
  });

  it('Assisted: plan approval required, never_auto', () => {
    expect(presetChanges({ preset: 'assisted' })).toEqual({
      ok: true,
      changes: [
        { key: 'planApproval', value: 'required' },
        { key: 'mergePolicy', value: 'never_auto' },
      ],
    });
  });

  it('Advanced: the fields as chosen, and each one is needed', () => {
    expect(
      presetChanges({ preset: 'advanced', planApproval: 'skip', mergePolicy: 'human_approval' }),
    ).toEqual({
      ok: true,
      changes: [
        { key: 'planApproval', value: 'skip' },
        { key: 'mergePolicy', value: 'human_approval' },
      ],
    });
    const missing = presetChanges({ preset: 'advanced', planApproval: 'skip' });
    expect(missing).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('refuse Controlled autonomy: it is not available yet', () => {
    const result = presetChanges({ preset: 'controlled_autonomy' });
    expect(result).toMatchObject({ ok: false, code: 'preset_not_available' });
    if (!result.ok) expect(result.message).toContain('auto_if_low_risk_and_green');
  });
});

describe('the finish checks', () => {
  it('pass with node, git and Claude Code present, a login and a Repository', () => {
    const checks = onboardingChecks(READY);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['node', 'pass'],
      ['git', 'pass'],
      ['claude', 'pass'],
      ['claude_login', 'pass'],
      ['repository', 'pass'],
    ]);
  });

  it('fail a missing or unusable tool, and no Repository registered', () => {
    const checks = onboardingChecks({
      ...READY,
      tools: { node: 'ok', git: 'missing', claude: 'failed' },
      repositories: 0,
    });
    expect(checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'git',
      'claude',
      'repository',
    ]);
  });

  it('warn when the login could not be detected safely, and fail a detected logout', () => {
    const unknown = onboardingChecks({ ...READY, claudeLogin: null });
    expect(unknown.find((c) => c.id === 'claude_login')).toMatchObject({ status: 'warning' });
    const out = onboardingChecks({ ...READY, claudeLogin: false });
    expect(out.find((c) => c.id === 'claude_login')).toMatchObject({ status: 'fail' });
  });

  it('do not ask for a login when Claude Code is billed to an API key', () => {
    const checks = onboardingChecks({ ...READY, claudeLogin: false, billing: 'api_key' });
    expect(checks.find((c) => c.id === 'claude_login')).toMatchObject({ status: 'pass' });
  });
});
