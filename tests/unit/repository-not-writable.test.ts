/**
 * `repository_not_writable` and Partial Completion (#108, ADR-0052, ADR-0068):
 * the preflight verdict before a Task's first Attempt, the push refusal that
 * raises the same Blocker, the held Repositories that let the others deliver,
 * and the "partial completion: N of M delivered" line. Pure; tested through
 * `@factory/domain`.
 */
import {
  blockerItemTitle,
  blockerOptions,
  isPushPermissionRefusal,
  partialCompletion,
  partialDelivery,
  repositoryWritability,
  type Blocker,
  type TaskState,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const API = { name: 'api', clonePath: '/clones/api' };

describe('repositoryWritability', () => {
  it('is writable when the Factory Clone is writable and the token may push', () => {
    expect(
      repositoryWritability({
        repository: API,
        clone: { writable: true },
        github: { label: 'acme/api', read: { ok: true, push: true } },
      }),
    ).toEqual({ kind: 'writable' });
  });

  it('is writable without GitHub Coordinates when the Factory Clone is', () => {
    expect(
      repositoryWritability({ repository: API, clone: { writable: true }, github: null }),
    ).toEqual({ kind: 'writable' });
  });

  it('names the Factory Clone and the error when the clone is not writable', () => {
    expect(
      repositoryWritability({
        repository: API,
        clone: { writable: false, problem: 'EACCES: permission denied' },
        github: { label: 'acme/api', read: { ok: true, push: true } },
      }),
    ).toEqual({
      kind: 'not_writable',
      detail:
        'the Factory Clone of api at /clones/api is not writable by the factory (EACCES: permission denied)',
    });
  });

  it('names the GitHub repository when the token has no push permission', () => {
    expect(
      repositoryWritability({
        repository: API,
        clone: { writable: true },
        github: { label: 'acme/api', read: { ok: true, push: false } },
      }),
    ).toEqual({
      kind: 'not_writable',
      detail:
        "the GitHub token has no push permission on acme/api (GitHub reports the repository's permissions.push as false), so the factory could not push api's Integration Branch",
    });
  });

  it('a refused read is not writable, with GitHub own words', () => {
    expect(
      repositoryWritability({
        repository: API,
        clone: { writable: true },
        github: {
          label: 'acme/api',
          read: { ok: false, kind: 'refused', status: 404, reason: 'Not Found' },
        },
      }),
    ).toEqual({
      kind: 'not_writable',
      detail:
        "the GitHub token can't read acme/api (refused 404: Not Found), so the factory could not push api's Integration Branch",
    });
  });

  it('a rate limit or a transient failure leaves it unchecked, never blocked', () => {
    for (const read of [
      { ok: false, kind: 'transient', status: 502, reason: 'Bad Gateway' },
      { ok: false, kind: 'rate_limited', status: 429, reason: 'rate limited until later' },
    ] as const) {
      expect(
        repositoryWritability({
          repository: API,
          clone: { writable: true },
          github: { label: 'acme/api', read },
        }).kind,
      ).toBe('unchecked');
    }
  });
});

describe('isPushPermissionRefusal', () => {
  it("recognises GitHub's permission refusals of a git push", () => {
    expect(
      isPushPermissionRefusal(
        "remote: Permission to acme/api.git denied to factory-bot. fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403",
      ),
    ).toBe(true);
    expect(isPushPermissionRefusal('remote: Write access to repository not granted.')).toBe(true);
    expect(isPushPermissionRefusal('The requested URL returned error: 403')).toBe(true);
  });

  it('a non-fast-forward or a network error is not a permission refusal', () => {
    expect(
      isPushPermissionRefusal(
        "! [rejected] HEAD -> factory/job/integration (non-fast-forward) error: failed to push some refs to 'https://github.com/acme/api.git'",
      ),
    ).toBe(false);
    expect(isPushPermissionRefusal('fatal: unable to access: Could not resolve host')).toBe(false);
  });
});

const notWritable: Blocker = {
  kind: 'infrastructure',
  reason: 'repository_not_writable',
  detail: 'the GitHub token has no push permission on acme/api',
  requiredAction: 'r',
  taskId: 't1',
  attemptId: 't1',
  createdAt: '2026-11-24T00:00:00.000Z',
};
const capped: Blocker = { ...notWritable, kind: 'human', reason: 'rework_cap_reached' };

const task = (
  key: string,
  repositoryId: string,
  state: TaskState,
  blocker: Blocker | null = null,
) => ({ key, repositoryId, state, blocker });

describe('partialDelivery', () => {
  it('holds a Repository with an unwritable Task once every other Repository is approved', () => {
    expect(
      partialDelivery([
        task('api-a', 'api', 'blocked', notWritable),
        task('api-b', 'api', 'pending'),
        task('web-a', 'web', 'approved'),
      ]),
    ).toEqual({ held: ['api'], blocker: notWritable });
  });

  it('is null while another Task is in progress, failed or blocked for another reason', () => {
    const blocked = task('api-a', 'api', 'blocked', notWritable);
    expect(partialDelivery([blocked, task('web-a', 'web', 'running')])).toBeNull();
    expect(partialDelivery([blocked, task('web-a', 'web', 'failed')])).toBeNull();
    expect(partialDelivery([blocked, task('web-a', 'web', 'blocked', capped)])).toBeNull();
  });

  it('is null when a Task of another Repository waits on the held one (a dependent waits)', () => {
    expect(
      partialDelivery([
        task('api-a', 'api', 'blocked', notWritable),
        task('web-a', 'web', 'pending'),
      ]),
    ).toBeNull();
  });

  it('is null when nothing is held, or nothing else is left to deliver', () => {
    expect(partialDelivery([task('web-a', 'web', 'approved')])).toBeNull();
    expect(partialDelivery([task('api-a', 'api', 'blocked', notWritable)])).toBeNull();
  });
});

describe('partialCompletion', () => {
  it('counts the delivered Repositories when some are and some are not', () => {
    expect(partialCompletion(['not_delivered', 'awaiting_merge'])).toEqual({
      delivered: 1,
      total: 2,
      line: 'partial completion: 1 of 2 delivered',
    });
    expect(partialCompletion(['merged', 'delivered_locally', 'pr_closed'])).toEqual({
      delivered: 2,
      total: 3,
      line: 'partial completion: 2 of 3 delivered',
    });
  });

  it('is null when every Repository, or none, was delivered', () => {
    expect(partialCompletion(['merged', 'awaiting_merge'])).toBeNull();
    expect(partialCompletion(['not_delivered', 'not_delivered'])).toBeNull();
    expect(partialCompletion(['merged'])).toBeNull();
  });
});

describe('the repository_not_writable Blocker Approval', () => {
  it('offers to check again or cancel the Job', () => {
    expect(blockerOptions('repository_not_writable')?.map((o) => o.id)).toEqual([
      'retry_check',
      'cancel_job',
    ]);
    expect(blockerItemTitle('api-a', 'repository_not_writable')).toBe(
      "Task api-a can't start: its Repository is not writable",
    );
    expect(blockerItemTitle('integration', 'repository_not_writable', 'integration')).toBe(
      "Integration Task can't be delivered: its Repository is not writable",
    );
  });
});
