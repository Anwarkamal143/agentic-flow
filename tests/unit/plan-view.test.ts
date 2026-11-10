/**
 * What the plan approval view derives by code (PRODUCT_SPEC §7): the human
 * decision points (from the Workflow Snapshot and policy, never the planner),
 * the Tasks that can start together, and the estimate bounds. Pure.
 */
import {
  FEATURE_RECIPE,
  humanDecisionPoints,
  parallelWaves,
  planEstimate,
  type WorkflowSnapshot,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('the estimate', () => {
  it('bounds Attempts from the Task count to the sum of every Attempt-creating cap', () => {
    const estimate = planEstimate(
      [
        { maxAttempts: 3, maxRetries: 2 },
        { maxAttempts: 2, maxRetries: 0 },
      ],
      { maxQuestions: 3, billing: 'subscription' },
    );
    // (3 + 2 + 3) + (2 + 0 + 3) = 13
    expect(estimate).toMatchObject({
      taskCount: 2,
      attempts: { min: 2, max: 13, label: 'bounds, not a forecast' },
      cost: { value: 'unknown' },
    });
    expect(estimate.cost.reason).toMatch(/subscription/);
  });

  it('says why the cost is unknown under an API key too', () => {
    const estimate = planEstimate([{ maxAttempts: 1, maxRetries: 0 }], {
      maxQuestions: 0,
      billing: 'api_key',
    });
    expect(estimate.attempts).toMatchObject({ min: 1, max: 1 });
    expect(estimate.cost.value).toBe('unknown');
    expect(estimate.cost.reason).toMatch(/token/);
  });
});

describe('the Tasks that can start together', () => {
  it('groups a DAG into waves where no Task depends on another of its wave', () => {
    expect(
      parallelWaves([
        { key: 'a', dependsOn: [] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['a'] },
        { key: 'd', dependsOn: ['b', 'c'] },
        { key: 'e', dependsOn: [] },
      ]),
    ).toEqual([['a', 'e'], ['b', 'c'], ['d']]);
  });

  it('puts a chain one Task per wave, by its longest dependency path', () => {
    expect(
      parallelWaves([
        { key: 'z', dependsOn: ['y', 'x'] },
        { key: 'y', dependsOn: ['x'] },
        { key: 'x', dependsOn: [] },
      ]),
    ).toEqual([['x'], ['y'], ['z']]);
  });
});

describe('the human decision points', () => {
  it('include plan approval when the policy requires it, then the execution Blockers', () => {
    const points = humanDecisionPoints(FEATURE_RECIPE, { planApproval: 'required' });
    expect(points.map((p) => [p.stageId, p.kind])).toEqual([
      ['plan_approval', 'plan'],
      ['execution', 'blocker'],
      ['execution', 'blocker'],
    ]);
  });

  it('leave plan approval out when the policy skips it', () => {
    const points = humanDecisionPoints(FEATURE_RECIPE, { planApproval: 'skip' });
    expect(points.map((p) => p.stageId)).toEqual(['execution', 'execution']);
  });

  it('come only from the Stages the Workflow Snapshot has', () => {
    const noApproval: WorkflowSnapshot = {
      recipeId: 'feature',
      recipeVersion: 1,
      stages: FEATURE_RECIPE.stages.filter((s) => s.id !== 'plan_approval'),
    };
    expect(
      humanDecisionPoints(noApproval, { planApproval: 'required' }).map((p) => p.stageId),
    ).not.toContain('plan_approval');
    const proposalsOnly: WorkflowSnapshot = {
      recipeId: 'feature',
      recipeVersion: 2,
      stages: [{ id: 'intake' }, { id: 'triage' }],
    };
    expect(humanDecisionPoints(proposalsOnly, { planApproval: 'required' })).toEqual([]);
  });
});
