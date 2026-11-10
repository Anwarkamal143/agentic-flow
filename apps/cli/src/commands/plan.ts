/**
 * `factory plan show --raw`, `plan edit` and `plan request-changes` (ADR-0019).
 * Each reads the Job's plan approval view first and sends the version and the
 * Plan it saw, so a stale view is refused by the runtime.
 */
import { readFileSync } from 'node:fs';
import type { Approval, EditPlanInput, PlanView, RequestPlanChangesInput } from '@factory/domain';
import type { RuntimeClient } from '../client.js';
import { refused } from './inbox.js';
import { client } from './job.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

/** `factory plan show <job> --raw`: the newest Plan as JSON, the input `plan edit` takes. */
export async function planRaw(jobId: string): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const view = await viewOf(api, jobId);
  if (view === undefined) return 1;
  const plan = await api.json<unknown>(
    'GET',
    `/v1/artifacts/${encodeURIComponent(view.planArtifactId)}/content`,
  );
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

/** `factory plan edit <job> --file <plan.json>`: replaces the waiting Plan with the file's. */
export async function planEdit(jobId: string, opts: { file: string }): Promise<number> {
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(opts.file, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `factory: could not read a JSON Plan from ${opts.file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await openItemOf(api, jobId);
  if (item === undefined) return 1;
  const input: EditPlanInput = {
    expectedVersion: item.version,
    planArtifactId: item.subjectRef,
    plan,
  };
  const opened = await refused(() =>
    api.json<Approval>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/plan/edit`, {
      body: input,
    }),
  );
  if (opened === undefined) return 1;
  process.stdout.write(
    `Plan ${opened.subjectRef} replaces ${item.subjectRef} (a Plan Edit; not a Replan).\n` +
      `It waits on Inbox Item ${opened.id} (version ${String(opened.version)}).\n`,
  );
  return 0;
}

/** `factory plan request-changes <job> --feedback <text>`: a Replan with the feedback. */
export async function planRequestChanges(
  jobId: string,
  opts: { feedback: string },
): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await openItemOf(api, jobId);
  if (item === undefined) return 1;
  const input: RequestPlanChangesInput = {
    expectedVersion: item.version,
    planArtifactId: item.subjectRef,
    feedback: opts.feedback,
  };
  const decided = await refused(() =>
    api.json<Approval>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/plan/request-changes`, {
      body: input,
    }),
  );
  if (decided === undefined) return 1;
  process.stdout.write(
    `Requested changes to Plan ${item.subjectRef}: the planner re-plans with your feedback.\n`,
  );
  return 0;
}

function viewOf(api: RuntimeClient, jobId: string): Promise<PlanView | undefined> {
  return refused(() => api.json<PlanView>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/plan`));
}

/** The open plan item the view shows, or a message and `undefined`. */
async function openItemOf(api: RuntimeClient, jobId: string): Promise<Approval | undefined> {
  const view = await viewOf(api, jobId);
  if (view === undefined) return undefined;
  if (view.approval?.state !== 'open') {
    process.stderr.write(`factory: refused: Job ${jobId} has no Plan waiting for approval\n`);
    return undefined;
  }
  return view.approval;
}
