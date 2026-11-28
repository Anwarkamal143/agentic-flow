/**
 * A triage-chosen Repository set (#107, ADR-0052, ADR-0067): when `job create`
 * names no Repository of a Project with several, triage proposes the set, only
 * from the Project's Repositories. A named set is never changed. A chosen set
 * of more than one waits for a human even under `planApproval: skip`. Pure;
 * tested through `@factory/domain`.
 */
import {
  FEATURE_RECIPE,
  humanDecisionPoints,
  repositorySetNeedsConfirmation,
  TriageProposalSchema,
  triageRepositorySet,
  validateTriage,
  WorkflowSnapshotSchema,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const API = { id: 'repo_api', name: 'api' };
const WEB = { id: 'repo_web', name: 'web' };
const ADMIN = { id: 'repo_admin', name: 'admin' };
const PROJECT = [ADMIN, API, WEB];

const triage = (repositories?: string[]) =>
  TriageProposalSchema.parse({
    summary: 'Add and use sum().',
    type: 'feature',
    risk: 'low',
    ...(repositories === undefined ? {} : { repositories }),
  });

describe('validateTriage', () => {
  it('accepts a set chosen from the Project’s Repositories', () => {
    expect(validateTriage(triage(['web', 'api']), PROJECT)).toEqual([]);
  });

  it('requires a set when triage chooses one, naming the candidates', () => {
    const issues = validateTriage(triage(), PROJECT);
    expect(issues).toEqual([
      {
        rule: 'triage.repositories',
        message:
          "choose the Repositories the Job changes, by name, from the Project's: admin, api, web",
      },
    ]);
  });

  it('refuses a Repository outside the Project, and a repeated one', () => {
    const issues = validateTriage(triage(['api', 'billing', 'api']), PROJECT);
    expect(issues.map((i) => i.rule)).toEqual(['triage.repositories', 'triage.repositories']);
    expect(issues[0]?.message).toBe(
      'billing is not a Repository of the Project (its Repositories: admin, api, web)',
    );
    expect(issues[1]?.message).toBe('api is listed more than once');
  });

  it('never judges a named set: a proposed set is ignored', () => {
    expect(validateTriage(triage(['billing']), null)).toEqual([]);
    expect(validateTriage(triage(), null)).toEqual([]);
  });
});

describe('triageRepositorySet', () => {
  it('is the chosen Repositories, by name', () => {
    expect(triageRepositorySet(triage(['web', 'api']), PROJECT)).toEqual([API, WEB]);
  });
});

describe('repositorySetNeedsConfirmation', () => {
  it('holds a triage-chosen set of more than one until a Plan is approved', () => {
    expect(repositorySetNeedsConfirmation({ setBy: 'triage', count: 2, confirmed: false })).toBe(
      true,
    );
    expect(repositorySetNeedsConfirmation({ setBy: 'triage', count: 2, confirmed: true })).toBe(
      false,
    );
  });

  it('never holds a set of one, or one the operator named', () => {
    expect(repositorySetNeedsConfirmation({ setBy: 'triage', count: 1, confirmed: false })).toBe(
      false,
    );
    expect(repositorySetNeedsConfirmation({ setBy: 'operator', count: 3, confirmed: false })).toBe(
      false,
    );
  });
});

describe('humanDecisionPoints', () => {
  const snapshot = WorkflowSnapshotSchema.parse(structuredClone(FEATURE_RECIPE));

  it('lists the set confirmation at plan_approval even under planApproval: skip', () => {
    const points = humanDecisionPoints(snapshot, {
      planApproval: 'skip',
      confirmRepositorySet: true,
    });
    expect(points[0]).toEqual({
      stageId: 'plan_approval',
      kind: 'plan',
      description:
        'Before any Task runs: approve or reject this Plan and the Repository set triage chose (a triage-chosen set of more than one waits for a human, even under planApproval: skip).',
    });
  });

  it('lists no plan decision under skip without a set to confirm', () => {
    const points = humanDecisionPoints(snapshot, { planApproval: 'skip' });
    expect(points.some((p) => p.stageId === 'plan_approval')).toBe(false);
  });
});
