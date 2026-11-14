/**
 * Capacity tokens (ARCHITECTURE §12 step 2, ADR-0020): a Task is claimed only
 * when a token is free under each of the global, per-Repository and per-Job
 * limits, and the tokens it gets are the lowest free slots. Pure; tested
 * through `@factory/domain`.
 */
import {
  CAPACITY_RESOURCE,
  claimCapacity,
  type CapacityLimits,
  type HeldCapacityToken,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const limits: CapacityLimits = { global: 3, perRepository: 2, perJob: 2 };
const subject = { repositoryId: 'repo_1', jobId: 'job_1' };

const globalToken = (i: number): HeldCapacityToken => ({
  resourceKind: CAPACITY_RESOURCE.global,
  resourceId: String(i),
});
const repoToken = (repo: string, i: number): HeldCapacityToken => ({
  resourceKind: CAPACITY_RESOURCE.repository,
  resourceId: `${repo}:${String(i)}`,
});
const jobToken = (job: string, i: number): HeldCapacityToken => ({
  resourceKind: CAPACITY_RESOURCE.job,
  resourceId: `${job}:${String(i)}`,
});

describe('claimCapacity', () => {
  it('grants slot 0 of each limit when nothing is held', () => {
    expect(claimCapacity({ limits, ...subject, held: [] })).toEqual({
      kind: 'granted',
      tokens: [
        { resourceKind: 'capacity.global', resourceId: '0' },
        { resourceKind: 'capacity.repository', resourceId: 'repo_1:0' },
        { resourceKind: 'capacity.job', resourceId: 'job_1:0' },
      ],
    });
  });

  it('grants the lowest free slot of each limit', () => {
    const held = [globalToken(0), globalToken(2), repoToken('repo_1', 1), jobToken('job_2', 0)];
    expect(claimCapacity({ limits, ...subject, held })).toEqual({
      kind: 'granted',
      tokens: [
        { resourceKind: 'capacity.global', resourceId: '1' },
        { resourceKind: 'capacity.repository', resourceId: 'repo_1:0' },
        { resourceKind: 'capacity.job', resourceId: 'job_1:0' },
      ],
    });
  });

  it('refuses when the Job holds perJob tokens, naming the limit', () => {
    const held = [globalToken(0), globalToken(1), jobToken('job_1', 0), jobToken('job_1', 1)];
    expect(claimCapacity({ limits, ...subject, held })).toEqual({
      kind: 'full',
      limit: 'job',
      held: 2,
      max: 2,
    });
  });

  it('refuses when the Repository is full, even across Jobs', () => {
    const held = [repoToken('repo_1', 0), repoToken('repo_1', 1), jobToken('job_2', 0)];
    expect(claimCapacity({ limits, ...subject, held })).toMatchObject({
      kind: 'full',
      limit: 'repository',
    });
  });

  it('refuses when the global limit is reached, whatever the Repository and Job', () => {
    const held = [globalToken(0), globalToken(1), globalToken(2)];
    expect(claimCapacity({ limits, ...subject, held })).toEqual({
      kind: 'full',
      limit: 'global',
      held: 3,
      max: 3,
    });
  });

  it("counts tokens another Job holds above this Job's lower limit", () => {
    // Another Job, allowed 4 on this Repository, holds slots 2 and 3: this Job's limit is 2.
    const held = [repoToken('repo_1', 2), repoToken('repo_1', 3)];
    expect(claimCapacity({ limits, ...subject, held })).toMatchObject({
      kind: 'full',
      limit: 'repository',
      held: 2,
    });
  });

  it("ignores other Repositories' and other Jobs' tokens for the per-scope limits", () => {
    const held = [repoToken('repo_2', 0), repoToken('repo_2', 1), jobToken('job_2', 0)];
    expect(claimCapacity({ limits, ...subject, held })).toMatchObject({ kind: 'granted' });
  });
});
