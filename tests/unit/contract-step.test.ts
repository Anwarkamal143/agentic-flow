/**
 * The contract step as a follow-up Job (ADR-0052, #110): the Plan's deferred
 * Tasks never run in the Job. The Delivery Report lists them as the pending
 * contract step; once every Repository's pull request has merged, an Approval
 * offers a follow-up Job carrying them as its description. Pure rules only.
 */
import {
  CONTRACT_JOB_OPTIONS,
  contractJobItemText,
  contractJobOffered,
  contractJobRequest,
  contractStep,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const REPOSITORIES = [
  { id: 'repo_api', name: 'api' },
  { id: 'repo_web', name: 'web' },
];

const task = (key: string, repository: string, deferred: boolean, dependsOn: string[] = []) => ({
  key,
  title: `${key} title`,
  objective: `Do ${key}.`,
  repository,
  dependsOn,
  acceptance: ['AC-02'],
  scope: { writable: ['src/math.ts'] },
  deferred,
});

const PLAN = [
  task('api-expand', 'repo_api', false),
  task('web-use', 'repo_web', false, ['api-expand']),
  task('api-contract', 'repo_api', true, ['web-use']),
];

describe('contractStep', () => {
  it('lists the deferred Tasks as pending, by Repository name', () => {
    expect(contractStep(PLAN, REPOSITORIES)).toEqual({
      status: 'pending',
      repositories: ['api'],
      tasks: [
        {
          key: 'api-contract',
          title: 'api-contract title',
          repository: 'api',
          objective: 'Do api-contract.',
          dependsOn: ['web-use'],
          acceptance: ['AC-02'],
        },
      ],
      line: 'contract step pending: Task api-contract (api) was deferred by the Plan and did not run in this Job',
    });
  });

  it('is null when the Plan defers nothing', () => {
    expect(contractStep(PLAN.slice(0, 2), REPOSITORIES)).toBeNull();
  });
});

describe('contractJobOffered', () => {
  it('offers the follow-up only once every Repository’s pull request has merged', () => {
    expect(contractJobOffered(['merged', 'merged'])).toBe(true);
    expect(contractJobOffered(['merged', 'awaiting_merge'])).toBe(false);
    expect(contractJobOffered(['merged', 'not_delivered'])).toBe(false);
    // A local delivery: the factory never sees the merge.
    expect(contractJobOffered(['delivered_locally'])).toBe(false);
    expect(contractJobOffered([])).toBe(false);
  });
});

describe('the contract Job Approval', () => {
  const step = contractStep(PLAN, REPOSITORIES);
  if (step === null) throw new Error('no contract step');
  const job = { id: 'job_1', title: 'Rename sum()' };

  it('asks to start the contract Job for its Repositories, with the deferred Tasks as the why', () => {
    expect(contractJobItemText(step)).toEqual({
      question: 'Start the contract Job for api?',
      why: 'Every pull request of this Job has merged in Delivery Order, so its consumers have migrated. Its Plan deferred the contract step (removing the old interface): Task api-contract (api): api-contract title. Starting it creates a new Job with these Tasks as its description; it is planned and approved like any other Job.',
    });
    expect(CONTRACT_JOB_OPTIONS.map((o) => o.id)).toEqual(['start_job', 'decline']);
  });

  it('creates a Job over the contract Repositories with the deferred Tasks as its description', () => {
    expect(
      contractJobRequest(job, step, [{ code: 'AC-02', text: 'sum() is the only name left.' }]),
    ).toEqual({
      title: 'Contract step: Rename sum()',
      repositories: ['api'],
      description: [
        'The contract step of Job job_1 (Rename sum()): its Plan deferred these Tasks until every pull request had merged, and every one has.',
        '',
        '- Task api-contract (api): api-contract title',
        '  Objective: Do api-contract.',
        '  After (done in Job job_1): web-use',
        '  Acceptance: AC-02 sum() is the only name left.',
      ].join('\n'),
    });
  });

  it('keeps the title within the Job title limit', () => {
    const long = contractJobRequest({ id: 'job_1', title: 'x'.repeat(200) }, step, []);
    expect(long.title).toHaveLength(200);
    expect(long.title.startsWith('Contract step: x')).toBe(true);
  });
});
