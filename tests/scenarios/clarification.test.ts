/**
 * The clarification engine for proposal Stages (#111, PRODUCT_SPEC §5, Phase
 * D Q14, ADR-0071). Triage and specification end with categorized questions,
 * routed in code: Product, Security and Operational ones open one Inbox
 * Question batch grouped by category (Security marked as needing approver
 * rights); answering starts a new Stage Run with the answers, and the output
 * that asked stays an Artifact. Technical ones are the agent's to decide, kept
 * as a Decision Record. A Discoverable one re-runs the Stage once and then
 * blocks it with no Question; asking past `maxQuestions` blocks too. Asserted
 * through the API and the CLI only.
 */
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  json,
  registeredRepo,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface QuestionBody {
  id: string;
  source: string;
  text: string;
  options: string[];
  recommended: string | null;
  blocking: boolean;
  agentProposed: boolean;
  category?: string;
  requiresApprover?: boolean;
}
interface ItemBody {
  id: string;
  jobId: string;
  taskId: string | null;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  question: string;
  questions: QuestionBody[] | null;
  state: string;
  version: number;
}
interface ArtifactBody {
  id: string;
  kind: string;
  stageRunId: string | null;
}

const PRODUCT = {
  category: 'product',
  text: 'Should sum() accept more than two numbers?',
  options: ['two only', 'any number'],
  recommended: 'two only',
};
const SECURITY = {
  category: 'security',
  text: 'Allow the Task to write under scripts/?',
  options: ['deny', 'allow'],
  recommended: 'deny',
};
const OPERATIONAL = {
  category: 'operational',
  text: 'Run this Job with a higher concurrency limit?',
  options: ['keep', 'raise'],
  recommended: 'keep',
};
const TECHNICAL = {
  category: 'technical',
  text: 'Which numeric type should sum() use?',
  options: ['number', 'bigint'],
  decision: 'number',
  rationale: 'add() already uses number.',
};
const DISCOVERABLE = {
  category: 'discoverable',
  text: 'Which test framework does the Repository use?',
  options: [],
};

const withQuestions = (stage: string, questions: unknown[]) => ({
  output: { ...validOutput(stage), questions },
});
const plain = (stage: string) => ({ output: validOutput(stage) });

async function runtimeWith(
  stages: Record<string, unknown[]>,
  config: Record<string, unknown> = {},
): Promise<{ rt: RunningRuntime; job: JobBody }> {
  const home = await initializedHome();
  useFakeHarness(home, scriptWith(stages));
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  await skipPlanApproval(rt, repo.projectId, config);
  const created = await rt.home.cli(['job', 'create', '--title', 'Add sum()']);
  expect(created.code, created.stderr).toBe(0);
  const jobId = /Created Job (job_[0-9a-f]+)/.exec(created.stdout)?.[1];
  if (jobId === undefined) throw new Error(`no Job id in: ${created.stdout}`);
  return { rt, job: await json<JobBody>(rt.request(`/v1/jobs/${jobId}`)) };
}

const runsOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((r) => r.stageId === stageId).map((r) => r.state);

async function itemsOf(rt: RunningRuntime, jobId: string): Promise<ItemBody[]> {
  const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.jobId === jobId);
}

async function artifactsOf(rt: RunningRuntime, jobId: string): Promise<ArtifactBody[]> {
  return json<ArtifactBody[]>(rt.request(`/v1/jobs/${jobId}/artifacts`));
}

async function eventsOf(rt: RunningRuntime, jobId: string): Promise<EventBody[]> {
  return json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
}

describe('questions for a human from a proposal Stage', () => {
  it('opens one batch grouped by category; answering starts a new Stage Run with the answers', async () => {
    const { rt, job } = await runtimeWith({
      triage: [
        withQuestions('triage', [OPERATIONAL, TECHNICAL, SECURITY, PRODUCT]),
        plain('triage'),
      ],
    });
    const waiting = await waitForJob(rt, job.id, (j) => j.status === 'waiting_human');
    expect(runsOf(waiting, 'triage')).toEqual(['waiting_human']);

    const [item] = await itemsOf(rt, job.id);
    expect(item?.kind).toBe('question');
    expect(item?.stageId).toBe('triage');
    expect(item?.taskId).toBeNull();
    expect(
      item?.questions?.map((q) => [q.id, q.category, q.text, q.recommended, q.requiresApprover]),
    ).toEqual([
      ['q1', 'product', PRODUCT.text, 'two only', false],
      ['q2', 'security', SECURITY.text, 'deny', true],
      ['q3', 'operational', OPERATIONAL.text, 'keep', false],
    ]);
    expect(item?.questions?.every((q) => q.source === 'clarification' && q.agentProposed)).toBe(
      true,
    );

    // The output that asked is kept, never applied: no triage Artifact yet.
    const before = await artifactsOf(rt, job.id);
    expect(before.map((a) => a.kind).sort()).toEqual(['clarification', 'decision_record']);
    const record = before.find((a) => a.kind === 'decision_record');
    const decisions = await json<{ decisions: { question: string; decision: string }[] }>(
      rt.request(`/v1/artifacts/${record?.id ?? ''}/content`),
    );
    expect(decisions.decisions).toEqual([
      expect.objectContaining({ question: TECHNICAL.text, decision: 'number' }),
    ]);
    const asked = before.find((a) => a.kind === 'clarification');
    expect(item?.subjectRef).toBe(asked?.id);

    const shown = await rt.home.cli(['inbox', 'show', item?.id ?? '']);
    expect(shown.stdout).toContain('product');
    expect(shown.stdout).toContain('security (needs approver rights)');
    expect(shown.stdout).toContain('operational');

    const answered = await rt.home.cli([
      'inbox',
      'answer',
      item?.id ?? '',
      '--answer',
      'q1=two only',
      '--answer',
      'q2=deny',
      '--answer',
      'q3=keep',
      '--expect-version',
      String(item?.version ?? 0),
    ]);
    expect(answered.code, answered.stderr).toBe(0);

    const done = await waitForJob(rt, job.id, (j) => j.status === 'completed', 20_000);
    expect(runsOf(done, 'triage')).toEqual(['superseded', 'succeeded']);

    const after = await artifactsOf(rt, job.id);
    expect(after.filter((a) => a.kind === 'clarification').map((a) => a.id)).toEqual([asked?.id]);
    expect(after.filter((a) => a.kind === 'triage')).toHaveLength(1);

    const events = await eventsOf(rt, job.id);
    const starts = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'triage',
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]?.payload['clarification']).toBeUndefined();
    expect(starts[1]?.payload['clarification']).toEqual({
      rounds: [
        {
          artifactId: asked?.id,
          route: 'ask',
          answers: [
            { question: PRODUCT.text, category: 'product', answer: 'two only' },
            { question: SECURITY.text, category: 'security', answer: 'deny' },
            { question: OPERATIONAL.text, category: 'operational', answer: 'keep' },
          ],
        },
      ],
    });
  });

  it('re-prompts a question for a human that offers no recommended default', async () => {
    const unrecommended = { category: 'product', text: PRODUCT.text, options: PRODUCT.options };
    const { rt, job } = await runtimeWith({
      specification: [withQuestions('specification', [unrecommended]), plain('specification')],
    });
    const done = await waitForJob(rt, job.id, (j) => j.status === 'completed', 20_000);
    expect(runsOf(done, 'specification')).toEqual(['succeeded']);
    const events = await eventsOf(rt, job.id);
    const finished = events.filter(
      (e) => e.type === 'harness_run.finished' && e.payload['stageId'] === 'specification',
    );
    expect(finished.map((e) => e.payload['outcome'])).toEqual(['invalid', 'valid']);
    expect(await itemsOf(rt, job.id)).toEqual([]);
  });

  it('blocks the Stage with no Question once it asks past maxQuestions', async () => {
    const { rt, job } = await runtimeWith(
      {
        specification: [
          withQuestions('specification', [PRODUCT]),
          withQuestions('specification', [OPERATIONAL]),
        ],
      },
      { maxQuestions: 1 },
    );
    await waitForJob(rt, job.id, (j) => j.status === 'waiting_human');
    const [item] = await itemsOf(rt, job.id);
    const answered = await rt.home.cli([
      'inbox',
      'answer',
      item?.id ?? '',
      '--answer',
      'any number',
      '--expect-version',
      String(item?.version ?? 0),
    ]);
    expect(answered.code, answered.stderr).toBe(0);

    const blocked = await waitForJob(rt, job.id, (j) => j.status === 'blocked');
    expect(runsOf(blocked, 'specification')).toEqual(['superseded', 'blocked']);
    const run = blocked.stageRuns.find(
      (r) => r.stageId === 'specification' && r.state === 'blocked',
    );
    expect(run?.blocker?.reason).toBe('clarification_cap_reached');
    // Only the first batch was ever opened.
    expect((await itemsOf(rt, job.id)).map((i) => i.state)).toEqual(['decided']);
    expect((await artifactsOf(rt, job.id)).filter((a) => a.kind === 'spec')).toEqual([]);
  });
});

describe('a Discoverable question', () => {
  it('re-runs the Stage once with a discovery instruction, and is never asked', async () => {
    const { rt, job } = await runtimeWith({
      specification: [withQuestions('specification', [DISCOVERABLE]), plain('specification')],
    });
    const done = await waitForJob(rt, job.id, (j) => j.status === 'completed', 20_000);
    expect(runsOf(done, 'specification')).toEqual(['superseded', 'succeeded']);
    expect(await itemsOf(rt, job.id)).toEqual([]);
    const events = await eventsOf(rt, job.id);
    const starts = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'specification',
    );
    expect(starts[1]?.payload['clarification']).toEqual({
      rounds: [expect.objectContaining({ route: 'discover', discover: [DISCOVERABLE.text] })],
    });
  });

  it('still open after the re-run, blocks the Stage with no Question', async () => {
    const { rt, job } = await runtimeWith({
      triage: [
        withQuestions('triage', [DISCOVERABLE, PRODUCT]),
        withQuestions('triage', [DISCOVERABLE]),
      ],
    });
    const blocked = await waitForJob(rt, job.id, (j) => j.status === 'blocked');
    expect(runsOf(blocked, 'triage')).toEqual(['superseded', 'blocked']);
    const run = blocked.stageRuns.find((r) => r.state === 'blocked');
    expect(run?.blocker).toEqual(
      expect.objectContaining({ kind: 'policy', reason: 'discoverable_unresolved' }),
    );
    expect(await itemsOf(rt, job.id)).toEqual([]);
    expect((await artifactsOf(rt, job.id)).map((a) => a.kind)).toEqual([
      'clarification',
      'clarification',
    ]);

    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain('discoverable_unresolved');

    // A blocked proposal Stage can be cancelled.
    const cancelled = await rt.home.cli(['job', 'cancel', job.id]);
    expect(cancelled.code, cancelled.stderr).toBe(0);
    await waitForJob(rt, job.id, (j) => j.status === 'cancelled');
  });
});
