/**
 * The setup wizard's write path (ADR-0074, beside the Inbox's, ADR-0022). Each
 * step's form posts here; its configuration goes to the runtime's ordinary
 * APIs server-side, as `user:local`, then Next is recorded with the wizard
 * version the page showed (a stale page is refused). Nothing is kept here: the
 * only wizard state is the runtime's last step completed. A write is accepted
 * only addressed to a loopback `Host` from the dashboard's own `Origin`.
 *
 * The forms work without scripts: success is a 303 to the next step's page,
 * a refusal a small HTML page with the reason and a link back.
 */
import {
  completeOnboardingStep,
  DetectedProfileSchema,
  MergePolicySchema,
  nextOnboardingStep,
  OnboardingStepSchema,
  PlanApprovalPolicySchema,
  PolicyPresetIdSchema,
  type OnboardingStep,
} from '@factory/domain';
import { z } from 'zod';
import { checkWriteOrigin } from '@/lib/loopback';
import { onboarding, RuntimeUnavailable, setupWrite, type SetupWriteResult } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const version = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);
/** An optional limit: empty leaves the key as it is; the runtime checks the range. */
const limit = z
  .string()
  .regex(/^\d{0,3}$/)
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)));

const NextForm = z.object({ expectedVersion: version });
const RegisterForm = z.object({
  action: z.literal('register'),
  project: z.string().trim().min(1).max(100),
  path: z.string().trim().min(1).max(4096),
  /** The detected profile the page showed, as JSON: what the human confirms. */
  profile: z.string().min(2).max(100_000),
});
const PresetForm = NextForm.extend({
  preset: PolicyPresetIdSchema,
  planApproval: PlanApprovalPolicySchema.optional(),
  mergePolicy: MergePolicySchema.optional(),
});
const ConcurrencyForm = NextForm.extend({
  global: limit,
  perRepository: limit,
  perJob: limit,
  perProjectJobs: limit,
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ step: string }> },
): Promise<Response> {
  const forbidden = checkWriteOrigin(request.headers);
  if (forbidden !== undefined) return Response.json({ error: forbidden }, { status: 403 });
  const parsedStep = OnboardingStepSchema.safeParse((await params).step);
  if (!parsedStep.success) return Response.json({ error: 'not_found' }, { status: 404 });
  const step = parsedStep.data;
  let fields: Record<string, string>;
  try {
    fields = Object.fromEntries(
      [...(await request.formData()).entries()].flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v]] : [],
      ),
    );
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    return await handle(step, fields);
  } catch (err) {
    if (err instanceof RuntimeUnavailable) {
      return refusal(503, 'The factory runtime is unavailable', err.message, step);
    }
    throw err;
  }
}

async function handle(step: OnboardingStep, fields: Record<string, string>): Promise<Response> {
  if (step === 'project' && fields['action'] === 'register') {
    const form = RegisterForm.safeParse(fields);
    const profile = form.success ? parseProfile(form.data.profile) : undefined;
    if (!form.success || profile === undefined) return invalid();
    // The Project is created when it doesn't exist yet: the human named it here.
    const created = await setupWrite('/v1/projects', { name: form.data.project });
    if (!created.ok && created.error !== 'project_exists') return refused(step, created);
    const registered = await setupWrite('/v1/repositories', {
      path: form.data.path,
      project: form.data.project,
      profile,
    });
    if (!registered.ok) {
      const kept = created.ok
        ? `Project '${form.data.project}' was created; the Repository was not registered.`
        : 'The Repository was not registered.';
      return refused(step, registered, kept);
    }
    return redirect('/setup/project');
  }

  const form = NextForm.safeParse(fields);
  if (!form.success) return invalid();
  // Refuse a stale page or a skipped step before writing any of the step's configuration.
  const current = await onboarding();
  if (current.version !== form.data.expectedVersion) {
    return refusal(
      409,
      'The step was refused',
      `the wizard is at version ${String(current.version)}, not ${String(form.data.expectedVersion)}: the page is stale`,
      step,
    );
  }
  const order = completeOnboardingStep(current.lastCompleted, step);
  if (!order.ok) return refusal(409, 'The step was refused', order.message, step);
  let wrote = false;
  if (step === 'preset') {
    const preset = PresetForm.safeParse(fields);
    if (!preset.success) return invalid();
    const { preset: id, planApproval, mergePolicy } = preset.data;
    const applied = await setupWrite(
      '/v1/factory/config/preset',
      id === 'advanced' ? { preset: id, planApproval, mergePolicy } : { preset: id },
    );
    if (!applied.ok) return refused(step, applied);
    wrote = true;
  }
  if (step === 'concurrency') {
    const limits = ConcurrencyForm.safeParse(fields);
    if (!limits.success) return invalid();
    const { global, perRepository, perJob, perProjectJobs } = limits.data;
    const values = { global, perRepository, perJob, perProjectJobs };
    const changes = Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : [{ key: `concurrency.${key}`, value }],
    );
    if (changes.length > 0) {
      const set = await setupWrite('/v1/factory/config/set-many', { changes });
      if (!set.ok) return refused(step, set);
      wrote = true;
    }
  }
  const done = await setupWrite('/v1/onboarding/complete', {
    step,
    expectedVersion: form.data.expectedVersion,
  });
  if (!done.ok) {
    const saved = wrote
      ? "This step's configuration was saved; the step was not recorded as completed."
      : undefined;
    return refused(step, done, saved);
  }
  const after = nextOnboardingStep(step);
  return redirect(after === null ? '/setup' : `/setup/${after}`);
}

function parseProfile(text: string): z.infer<typeof DetectedProfileSchema> | undefined {
  try {
    const parsed = DetectedProfileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function invalid(): Response {
  return Response.json({ error: 'invalid_request' }, { status: 400 });
}

function refused(
  step: OnboardingStep,
  result: SetupWriteResult & { ok: false },
  changed?: string,
): Response {
  return refusal(result.status, 'The step was refused', result.message, step, changed);
}

/** A page a browser without scripts can show: what was refused, why, and the way back. */
function refusal(
  status: number,
  title: string,
  message: string,
  step: OnboardingStep,
  changed = 'Nothing was changed.',
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><main role="alert">
<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
<p>${escape(changed)} <a href="/setup/${step}">Back to the step</a>, re-read it, and try again.</p>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
