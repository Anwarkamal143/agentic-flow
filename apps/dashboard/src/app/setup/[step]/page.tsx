/**
 * One step of the setup wizard (ADR-0053, ADR-0074). Every value shown is
 * read from the runtime; each form posts to `/api/setup/<step>`, which writes
 * through the runtime API and records Next. The page holds no draft: what a
 * step shows after Next is what the runtime persisted.
 */
import {
  ONBOARDING_STEPS,
  OnboardingStepSchema,
  POLICY_PRESETS,
  type FactoryLevel,
  type Onboarding,
  type OnboardingStep,
} from '@factory/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  doctor,
  factoryConfig,
  inspectRepository,
  onboarding,
  onboardingChecks,
  projectSummaries,
  runtimeStatus,
  RuntimeUnavailable,
} from '@/lib/runtime';

const TITLES: Readonly<Record<OnboardingStep, string>> = {
  basics: 'Basics',
  harnesses: 'Harnesses',
  github: 'GitHub',
  project: 'First Project and Repository',
  preset: 'Policy preset',
  concurrency: 'Concurrency',
  verification: 'Verification',
};

const button =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';
const input = 'rounded-md border px-2 py-1 text-sm';

export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const parsed = OnboardingStepSchema.safeParse((await params).step);
  if (!parsed.success) notFound();
  const step = parsed.data;
  const query = await searchParams;
  try {
    const state = await onboarding();
    const body = await StepBody({ step, state, query });
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Set up the factory</h1>
        <Stepper state={state} current={step} />
        <Card data-testid={`setup-${step}`}>
          <CardHeader>
            <CardTitle>{TITLES[step]}</CardTitle>
            <CardDescription>
              Each Next saves this step’s configuration through the runtime at once; the wizard
              keeps nothing else but the last step completed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">{body}</CardContent>
        </Card>
      </div>
    );
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
}

function Stepper({ state, current }: { state: Onboarding; current: OnboardingStep }) {
  const done = state.lastCompleted === null ? -1 : ONBOARDING_STEPS.indexOf(state.lastCompleted);
  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label="Setup steps">
      {ONBOARDING_STEPS.map((s, i) => {
        const reachable = i <= done + 1;
        const label = `${String(i + 1)}. ${TITLES[s]}`;
        return (
          <li key={s} aria-current={s === current ? 'step' : undefined}>
            {reachable ? (
              <Link
                href={`/setup/${s}`}
                className={`underline-offset-4 hover:underline ${s === current ? 'font-semibold' : ''}`}
              >
                {label}
              </Link>
            ) : (
              <span className="text-muted-foreground">{label}</span>
            )}{' '}
            {i <= done && <Badge variant="success">done</Badge>}
          </li>
        );
      })}
    </ol>
  );
}

/** Next on a step: the wizard version the page was rendered with, and `children` fields. */
function NextForm({
  step,
  state,
  label = 'Next',
  disabled = false,
  children,
}: {
  step: OnboardingStep;
  state: Onboarding;
  label?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <form method="post" action={`/api/setup/${step}`} className="space-y-4 border-t pt-4">
      <input type="hidden" name="expectedVersion" value={String(state.version)} />
      {children}
      <button type="submit" className={button} disabled={disabled}>
        {label}
      </button>
    </form>
  );
}

async function StepBody({
  step,
  state,
  query,
}: {
  step: OnboardingStep;
  state: Onboarding;
  query: Record<string, string | string[] | undefined>;
}): Promise<ReactNode> {
  switch (step) {
    case 'basics': {
      const status = await runtimeStatus();
      return (
        <>
          <dl className="grid gap-2 sm:grid-cols-2">
            <Row label="Factory home">{status.home}</Row>
            <Row label="Workspace root">{status.workspaceRoot}</Row>
            <Row label="Runtime">
              {status.version} at http://{status.host}:{status.port}
            </Row>
            <Row label="Database">
              SQLite, journal {status.database.journalMode}, {status.database.migrations} migrations
              applied
            </Row>
          </dl>
          <p className="text-muted-foreground">
            <code>factory init</code> set these; the wizard doesn’t change them. To use another home
            or workspace root, run <code>factory init</code> again with the factory stopped.
          </p>
          <NextForm step={step} state={state} />
        </>
      );
    }
    case 'harnesses': {
      const [status, report] = await Promise.all([runtimeStatus(), doctor()]);
      const claude = report.tools.find((t) => t.id === 'claude');
      const login = report.credentials.find((c) => c.id === 'claude_login');
      return (
        <>
          <dl className="grid gap-2 sm:grid-cols-2">
            <Row label="Configured Harness">
              {status.harness === null
                ? 'none configured (queued Stages wait)'
                : `${status.harness.id} ${status.harness.version ?? '(version unknown)'}`}
            </Row>
            <Row label="Billing">
              {status.harness?.billing === 'api_key'
                ? 'an API key (ANTHROPIC_API_KEY)'
                : status.harness?.billing === 'subscription'
                  ? 'your subscription login'
                  : 'not applicable'}
            </Row>
            <Row label="Claude Code on PATH">
              <span>Claude Code</span> <span>{claude?.version ?? claude?.status ?? 'missing'}</span>
              {claude?.fix !== undefined && (
                <span className="block text-muted-foreground">{claude.fix}</span>
              )}
            </Row>
            <Row label="Claude Code login">
              {login === undefined
                ? 'not checked (Claude Code is not usable)'
                : login.detected === false
                  ? 'could not be detected safely'
                  : login.present
                    ? 'present'
                    : 'absent'}
            </Row>
          </dl>
          <p className="text-muted-foreground">
            The Harness is chosen in the factory home’s <code>config.json</code>; the wizard shows
            it and doesn’t change it.
          </p>
          <NextForm step={step} state={state} />
        </>
      );
    }
    case 'github': {
      const report = await doctor();
      return (
        <>
          <p>
            GitHub is optional. Without it the factory delivers locally only: an Integration Branch
            in its own clone, no pull request.
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <Row label="API">{report.github.apiBaseUrl}</Row>
            <Row label="Token reference">
              {report.github.tokenReference}:{' '}
              {report.github.resolves
                ? 'resolves'
                : `does not resolve (${report.github.problem ?? 'no reason given'})`}
            </Row>
          </dl>
          <p className="text-muted-foreground">
            The token reference is set in <code>config.json</code> (<code>github.token</code>); the
            token itself is never shown. A Repository gets its GitHub coordinates when it is
            registered.
          </p>
          <NextForm step={step} state={state} />
          <NextForm step={step} state={state} label="Skip GitHub: local Delivery only" />
        </>
      );
    }
    case 'project':
      return <ProjectStep state={state} query={query} />;
    case 'preset': {
      const level = await factoryConfig();
      return <PresetStep state={state} level={level} />;
    }
    case 'concurrency': {
      const level = await factoryConfig();
      const c = level.config.concurrency ?? {};
      const fields = [
        ['global', 'Tasks in flight at once, over every Job (default 3)', c.global],
        ['perRepository', 'Tasks per Repository (recipe default)', c.perRepository],
        ['perJob', 'Tasks per Job (recipe default)', c.perJob],
        ['perProjectJobs', 'Jobs of one Project in flight (default unlimited)', c.perProjectJobs],
      ] as const;
      return (
        <NextForm step={step} state={state}>
          <p className="text-muted-foreground">
            Saved at the Factory Level (Factory Level version {level.version}). Leave a field empty
            to keep it as it is.
          </p>
          {fields.map(([name, label, value]) => (
            <label key={name} className="flex items-center gap-2">
              <span className="w-80">{label}</span>
              <input
                className={input}
                type="number"
                min={1}
                name={name}
                defaultValue={value === undefined ? '' : String(value)}
              />
            </label>
          ))}
        </NextForm>
      );
    }
    case 'verification':
      return <VerificationStep state={state} />;
  }
}

async function ProjectStep({
  state,
  query,
}: {
  state: Onboarding;
  query: Record<string, string | string[] | undefined>;
}) {
  const projects = await projectSummaries();
  const name = typeof query['project'] === 'string' ? query['project'] : '';
  const path = typeof query['path'] === 'string' ? query['path'] : '';
  const inspection = path === '' ? undefined : await inspectRepository(path);
  const registered = projects.flatMap((p) => p.repositories.map((r) => ({ project: p, repo: r })));
  return (
    <>
      {registered.length === 0 ? (
        <p>No Repository is registered yet.</p>
      ) : (
        <ul className="space-y-1" data-testid="registered">
          {registered.map(({ project, repo }) => (
            <li key={repo.id}>
              Project <span className="font-medium">{project.name}</span>: Repository{' '}
              <Link href={`/repositories/${repo.id}`} className="underline underline-offset-4">
                {repo.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form method="get" action="/setup/project" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Project (created if new)</span>
          <input className={input} name="project" defaultValue={name || 'default'} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Path of a local git checkout</span>
          <input className={`${input} w-96`} name="path" defaultValue={path} required />
        </label>
        <button type="submit" className={button}>
          Detect its profile
        </button>
      </form>
      {inspection !== undefined &&
        (inspection.ok ? (
          <form
            method="post"
            action="/api/setup/project"
            className="space-y-2 rounded-md border p-3"
            data-testid="detected"
          >
            <p className="font-medium">
              Profile Detection proposes, for {inspection.inspection.name} (
              {inspection.inspection.source}):
            </p>
            <dl className="grid gap-2 sm:grid-cols-2">
              <Row label="Package manager">
                {inspection.inspection.detected.packageManager ?? 'none detected'}
              </Row>
              <Row label="Commands">
                {Object.entries(inspection.inspection.detected.commands)
                  .map(([k, c]) => `${k}: ${c.run}`)
                  .join(' · ') || 'none detected'}
              </Row>
              <Row label="CI files">
                {inspection.inspection.detected.ciFiles.map((f) => f.path).join(', ') || 'none'}
              </Row>
              <Row label="Instruction files">
                {inspection.inspection.detected.instructionFiles.join(', ') || 'none'}
              </Row>
              <Row label="Sensitive Paths">
                {inspection.inspection.detected.sensitivePaths.join(', ')}
              </Row>
              <Row label="GitHub">
                {inspection.inspection.github === null
                  ? 'no GitHub coordinates (local Delivery only)'
                  : `${inspection.inspection.github.owner}/${inspection.inspection.github.name}`}
              </Row>
            </dl>
            <p className="text-muted-foreground">
              No setup command is ever detected; set one later with{' '}
              <code>factory repo profile set &lt;repo&gt; setup &lt;cmd&gt;</code>. Your checkout is
              never modified: the factory makes its own clone.
            </p>
            <input type="hidden" name="action" value="register" />
            <input type="hidden" name="project" value={name} />
            <input type="hidden" name="path" value={path} />
            <input
              type="hidden"
              name="profile"
              value={JSON.stringify(inspection.inspection.detected)}
            />
            <button type="submit" className={button}>
              Confirm and register
            </button>
          </form>
        ) : (
          <p role="alert">
            Profile Detection could not read {path}: {inspection.message}
          </p>
        ))}
      <NextForm step="project" state={state} disabled={registered.length === 0} />
    </>
  );
}

function PresetStep({ state, level }: { state: Onboarding; level: FactoryLevel }) {
  return (
    <NextForm step="preset" state={state}>
      <p className="text-muted-foreground">
        Saved at the Factory Level, above every Project and Repository. Now: plan approval{' '}
        {level.config.planApproval ?? 'the recipe default'}, Merge Policy ceiling{' '}
        {level.config.mergePolicy ?? 'each Repository’s own'}.
      </p>
      <fieldset className="space-y-2">
        <legend className="sr-only">Policy preset</legend>
        {POLICY_PRESETS.map((p) => (
          <label key={p.id} className={`flex gap-2 ${p.available ? '' : 'opacity-60'}`}>
            <input
              type="radio"
              name="preset"
              value={p.id}
              defaultChecked={p.default}
              disabled={!p.available}
            />
            <span>
              <span className="font-medium">{p.label}</span>
              {p.default && (
                <Badge variant="success" className="ml-2">
                  default
                </Badge>
              )}
              {!p.available && (
                <Badge variant="secondary" className="ml-2">
                  not available yet
                </Badge>
              )}
              <span className="block text-muted-foreground">{p.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-4 rounded-md border p-3">
        <span className="w-full text-xs text-muted-foreground">Advanced only:</span>
        <label className="flex items-center gap-2">
          Plan approval
          <select className={input} name="planApproval" defaultValue="required">
            <option value="required">required</option>
            <option value="skip">skip</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Merge Policy ceiling
          <select className={input} name="mergePolicy" defaultValue="never_auto">
            <option value="never_auto">never_auto</option>
            <option value="human_approval">human_approval</option>
          </select>
        </label>
      </div>
    </NextForm>
  );
}

async function VerificationStep({ state }: { state: Onboarding }) {
  const result = await onboardingChecks();
  const variant = { pass: 'success', fail: 'destructive', warning: 'warning' } as const;
  return (
    <>
      {state.finished && (
        <p role="status" className="font-medium">
          Setup is finished. <Link href="/">Go to the Jobs</Link>, or create one with{' '}
          <code>factory job create --title &lt;t&gt;</code>.
        </p>
      )}
      <table className="w-full text-left">
        <tbody>
          {result.checks.map((c) => (
            <tr key={c.id} data-check={c.id} className="border-t">
              <td className="py-1 pr-4">{c.label}</td>
              <td className="py-1 pr-4">
                <Badge variant={variant[c.status]}>{c.status}</Badge>
              </td>
              <td className="py-1 text-muted-foreground">{c.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!result.canFinish && (
        <p role="alert">Finish is refused while a mandatory check fails. Fix it, then reload.</p>
      )}
      {!state.finished && (
        <NextForm step="verification" state={state} label="Finish" disabled={!result.canFinish} />
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
