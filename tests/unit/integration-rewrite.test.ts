/**
 * Rewriting a published Integration Branch (#65, ARCHITECTURE §8.1 and §14,
 * Q25): what the `pull_request` Stage does with the PR it recorded once the
 * Integration Task's approved head is known. A rebuilt branch (after a Replan
 * or a re-specification) that doesn't descend from the head the factory pushed
 * is published only through a human's `integration_rewrite` decision. Pure;
 * tested through `@factory/domain`.
 */
import { integrationBranch, pullRequestDelivery } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const open = { state: 'open' as const, pushedSha: 'p1', taskId: 'int-1' };

describe('pullRequestDelivery', () => {
  it('opens a PR when none is recorded: nothing was published, so no approval is needed', () => {
    expect(
      pullRequestDelivery({
        recorded: null,
        taskId: 'int-2',
        headSha: 'h2',
        fastForward: false,
        rewrite: null,
      }),
    ).toBe('open');
  });

  it('leaves a PR that already has the head, or is no longer open', () => {
    const input = { taskId: 'int-1', fastForward: false, rewrite: null };
    expect(pullRequestDelivery({ ...input, recorded: open, headSha: 'p1' })).toBe('none');
    for (const state of ['closed', 'merged'] as const) {
      expect(pullRequestDelivery({ ...input, recorded: { ...open, state }, headSha: 'h2' })).toBe(
        'none',
      );
    }
  });

  it('updates the same Task’s PR in place with a fast-forward (a Rework, a base merge-in)', () => {
    expect(
      pullRequestDelivery({
        recorded: open,
        taskId: 'int-1',
        headSha: 'h2',
        fastForward: true,
        rewrite: null,
      }),
    ).toBe('update');
  });

  it('waits on a human when a rebuilt Integration Branch would rewrite the open PR', () => {
    expect(
      pullRequestDelivery({
        recorded: open,
        taskId: 'int-2',
        headSha: 'h2',
        fastForward: false,
        rewrite: null,
      }),
    ).toBe('needs_approval');
  });

  it('carries out the route a human chose for the rebuilt branch, and nothing else', () => {
    const rebuilt = { recorded: open, taskId: 'int-2', headSha: 'h2', fastForward: false };
    expect(pullRequestDelivery({ ...rebuilt, rewrite: 'force_push_with_lease' })).toBe(
      'force_push',
    );
    expect(pullRequestDelivery({ ...rebuilt, rewrite: 'new_pr' })).toBe('new_pr');
  });

  it('updates in place with no approval when the rebuilt head still descends from the pushed one', () => {
    expect(
      pullRequestDelivery({
        recorded: open,
        taskId: 'int-2',
        headSha: 'h2',
        fastForward: true,
        rewrite: null,
      }),
    ).toBe('update');
  });
});

describe('integrationBranch', () => {
  it('names the first Integration Branch without a number, and a new PR’s with its number', () => {
    expect(integrationBranch('job_1')).toBe('factory/job_1/integration');
    expect(integrationBranch('job_1', 1)).toBe('factory/job_1/integration');
    expect(integrationBranch('job_1', 2)).toBe('factory/job_1/integration-2');
  });
});
