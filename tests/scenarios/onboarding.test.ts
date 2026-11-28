/**
 * The onboarding wizard (#114, ADR-0053, ADR-0074), through the built
 * dashboard over HTTP like a browser without scripts. Each step's Next writes
 * real configuration through the runtime API, visible through the CLI at once;
 * the only wizard state is the last step completed, in the database, and
 * resume opens the first step not completed. Finish is refused while a
 * mandatory check fails; an undetectable Claude Code login is a warning.
 */
import { describe, expect, it } from 'vitest';
import { json, post } from '../support/api.js';
import { startDashboard, type RunningDashboard } from '../support/dashboard.js';
import {
  fakeBin,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  versionTool,
  type RunningRuntime,
  type TestHome,
} from '../support/factory.js';

/** Claude Code with every flag the adapter needs (ADR-0013); `auth` is the `auth status` body. */
function claudeCode(auth: string): string {
  return versionTool(
    '2.1.4 (Claude Code)',
    `if [ "$1" = "--help" ]; then\n  printf '  %s <value>\\n' --print --output-format --verbose --session-id --permission-mode --permission-prompts --tools --allowed-tools --disallowed-tools --setting-sources --strict-mcp-config --disable-slash-commands --model\n  exit 0\nfi\nif [ "$1" = "auth" ]; then\n${auth}\nfi\nexit 1`,
  );
}
const LOGGED_IN = claudeCode('exit 0');
/** `claude auth status` killed before an exit code: the login can't be detected safely. */
const LOGIN_UNDETECTABLE = claudeCode('kill -9 $$');
/** Found on PATH, but `--version` prints no version: not usable. */
const BROKEN_CLAUDE = 'exit 1';

/** The real node and git, with a fake `claude` in front of them. */
async function runtimeWith(claude: string, home?: TestHome): Promise<RunningRuntime> {
  const bin = fakeBin({ claude });
  return startRuntime(home ?? (await initializedHome()), {
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
}

/** The text a browser shows: tags removed, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The one `<input>` tag of the page that has `attribute`. */
function inputTag(html: string, attribute: string): string {
  const tags = (html.match(/<input[^>]*>/g) ?? []).filter((t) => t.includes(attribute));
  expect(tags, attribute).toHaveLength(1);
  return tags[0] ?? '';
}

/** A hidden form field's value as the page rendered it, entities decoded. */
function hidden(html: string, name: string): string {
  const match = /value="([^"]*)"/.exec(inputTag(html, `name="${name}"`));
  if (match?.[1] === undefined) throw new Error(`no hidden field ${name}`);
  return match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface OnboardingBody {
  lastCompleted: string | null;
  next: string | null;
  finished: boolean;
  version: number;
}

function onboarding(rt: RunningRuntime): Promise<OnboardingBody> {
  return json<OnboardingBody>(rt.request('/v1/onboarding'));
}

async function cli(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

/** Where `/setup` sends the browser (resume). */
async function resumesAt(dash: RunningDashboard): Promise<string | null> {
  const res = await dash.request('/setup', { redirect: 'manual' });
  await res.body?.cancel();
  return res.headers.get('location');
}

/** Presses the step page's Next: the form as the page rendered it, plus `extra`. */
async function next(
  dash: RunningDashboard,
  rt: RunningRuntime,
  step: string,
  extra: Record<string, string> = {},
) {
  const { version } = await onboarding(rt);
  return dash.postForm(`/api/setup/${step}`, { expectedVersion: String(version), ...extra });
}

/** Completes the steps through the runtime API, as the dashboard's Next does. */
async function completeSteps(rt: RunningRuntime, steps: string[]): Promise<void> {
  for (const step of steps) {
    const res = await post(rt, '/v1/onboarding/complete', { step });
    expect(res.status, await res.clone().text()).toBe(200);
  }
}

async function registerRepository(rt: RunningRuntime): Promise<void> {
  expect((await post(rt, '/v1/projects', { name: 'demo' })).status).toBe(201);
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  expect(res.code, res.stderr).toBe(0);
}

describe('the onboarding wizard', () => {
  it('walks every step; each Next writes real configuration the CLI shows at once', async () => {
    const rt = await runtimeWith(LOGGED_IN);
    const dash = await startDashboard(rt.home);
    expect(await cli(rt, ['status'])).toContain('setup:          0 of 7 steps completed');
    expect(await resumesAt(dash)).toMatch(/\/setup\/basics$/);

    // Basics, harnesses and GitHub show what `factory init` and doctor found.
    const basics = text(await dash.html('/setup/basics'));
    expect(basics).toContain('Basics');
    expect(basics).toContain(rt.home.dir);
    expect((await next(dash, rt, 'basics')).location).toBe('/setup/harnesses');
    expect(text(await dash.html('/setup/harnesses'))).toContain('Claude Code 2.1.4');
    expect((await next(dash, rt, 'harnesses')).location).toBe('/setup/github');
    const github = text(await dash.html('/setup/github'));
    expect(github).toContain('GitHub is optional');
    expect(github).toContain('Skip GitHub: local Delivery only');
    expect((await next(dash, rt, 'github')).location).toBe('/setup/project');
    expect(await cli(rt, ['status'])).toContain(
      'setup:          3 of 7 steps completed, resumes at project',
    );

    // Project and Repository: Next is refused until one is registered.
    const early = await next(dash, rt, 'project');
    expect(early.status).toBe(409);
    expect(text(early.body)).toContain('register a Repository before going on');
    const repo = tinyTsRepo();
    const proposalHtml = await dash.html(
      `/setup/project?project=shop&path=${encodeURIComponent(repo)}`,
    );
    const proposal = text(proposalHtml);
    expect(proposal).toContain('Profile Detection proposes');
    expect(proposal).toContain('Confirm and register');
    expect(proposal).toContain('Package manager npm');
    // Detection wrote nothing: no Project, no Repository yet.
    expect(await cli(rt, ['project', 'list'])).not.toContain('shop');
    const register = await dash.postForm('/api/setup/project', {
      action: 'register',
      project: 'shop',
      path: repo,
      profile: hidden(proposalHtml, 'profile'),
    });
    expect(register.status, register.body).toBe(303);
    expect(register.location).toBe('/setup/project');
    const projects = await cli(rt, ['project', 'list']);
    expect(projects).toContain('shop');
    expect(projects).toContain('tiny-ts');
    expect(await cli(rt, ['project', 'show', 'shop'])).toContain('tiny-ts');
    expect((await next(dash, rt, 'project')).location).toBe('/setup/preset');

    // The presets: Assisted is the default, Controlled autonomy is not available yet.
    const presetHtml = await dash.html('/setup/preset');
    const presets = text(presetHtml);
    for (const label of ['Manual', 'Assisted', 'Controlled autonomy', 'Advanced']) {
      expect(presets).toContain(label);
    }
    expect(presets).toContain('not available yet');
    expect(inputTag(presetHtml, 'value="assisted"')).toContain('checked');
    expect(inputTag(presetHtml, 'value="controlled_autonomy"')).toContain('disabled');
    const controlled = await next(dash, rt, 'preset', { preset: 'controlled_autonomy' });
    expect(controlled.status).toBe(400);
    expect(text(controlled.body)).toContain('not available yet');
    expect((await next(dash, rt, 'preset', { preset: 'manual' })).location).toBe(
      '/setup/concurrency',
    );
    const manual = await cli(rt, ['config', 'show']);
    expect(manual).toMatch(/planApproval +required +\(factory\)/);
    expect(manual).toMatch(/mergePolicy +never_auto +\(factory\)/);
    expect(manual).toMatch(/concurrency\.global +1 +\(factory\)/);

    // Concurrency: the form starts from the Factory Level's values.
    expect(inputTag(await dash.html('/setup/concurrency'), 'name="global"')).toContain('value="1"');
    const concurrency = await next(dash, rt, 'concurrency', {
      global: '2',
      perRepository: '',
      perJob: '1',
      perProjectJobs: '',
    });
    expect(concurrency.location).toBe('/setup/verification');
    const shown = await cli(rt, ['config', 'show']);
    expect(shown).toMatch(/concurrency\.global +2 +\(factory\)/);
    expect(shown).toMatch(/concurrency\.perJob +1 +\(factory\)/);

    // Verification: every check passes, and Finish ends the wizard.
    const verification = text(await dash.html('/setup/verification'));
    expect(verification).toContain('Node.js pass');
    expect(verification).toContain('Claude Code login pass');
    expect(verification).toContain('A registered Repository pass');
    const finish = await next(dash, rt, 'verification');
    expect(finish.location).toBe('/setup');
    expect(text(await dash.html('/setup/verification'))).toContain('Setup is finished');
    expect(await cli(rt, ['status'])).toContain('setup:          finished');
    expect(await onboarding(rt)).toMatchObject({
      lastCompleted: 'verification',
      next: null,
      finished: true,
    });

    // Every Next was audited as the operator, in order.
    const events = await json<{ type: string; actor: string; payload: { step: string } }[]>(
      rt.request('/v1/events?limit=200'),
    );
    expect(
      events.filter((e) => e.type === 'onboarding.step_completed').map((e) => e.payload.step),
    ).toEqual([
      'basics',
      'harnesses',
      'github',
      'project',
      'preset',
      'concurrency',
      'verification',
    ]);
  });

  it('resumes at the first step not completed, after a restart too, and skips none', async () => {
    const home = await initializedHome();
    let rt = await runtimeWith(LOGGED_IN, home);
    await completeSteps(rt, ['basics', 'harnesses']);
    expect(await rt.stop()).toBe(0);
    rt = await runtimeWith(LOGGED_IN, home);
    const dash = await startDashboard(rt.home);

    expect(await resumesAt(dash)).toMatch(/\/setup\/github$/);
    expect(await onboarding(rt)).toMatchObject({ lastCompleted: 'harnesses', next: 'github' });

    // A later step can't be completed before the ones in between.
    const skip = await next(dash, rt, 'preset', { preset: 'assisted' });
    expect(skip.status).toBe(409);
    expect(text(skip.body)).toContain("comes after 'github'");
    // Going back to an earlier step and pressing Next keeps the furthest step.
    expect((await next(dash, rt, 'basics')).location).toBe('/setup/harnesses');
    expect(await resumesAt(dash)).toMatch(/\/setup\/github$/);

    // A stale page is refused.
    const stale = await dash.postForm('/api/setup/github', { expectedVersion: '1' });
    expect(stale.status).toBe(409);
    expect(text(stale.body)).toContain('Nothing was changed');
  });

  it('refuses Finish while a mandatory check fails', async () => {
    const rt = await runtimeWith(BROKEN_CLAUDE);
    const dash = await startDashboard(rt.home);
    await completeSteps(rt, ['basics', 'harnesses', 'github']);
    // No Repository yet either: the project step's Next is refused through the API too.
    const refused = await post(rt, '/v1/onboarding/complete', { step: 'project' });
    expect(refused.status).toBe(409);
    await registerRepository(rt);
    await completeSteps(rt, ['project', 'preset', 'concurrency']);

    const page = await dash.html('/setup/verification');
    expect(text(page)).toContain('Claude Code fail');
    expect(page).toMatch(/<button[^>]*disabled[^>]*>Finish/);
    const finish = await next(dash, rt, 'verification');
    expect(finish.status).toBe(409);
    expect(text(finish.body)).toContain("setup can't finish while a mandatory check fails");
    expect(text(finish.body)).toContain('Claude Code');
    expect(await onboarding(rt)).toMatchObject({ lastCompleted: 'concurrency', finished: false });
  });

  it('finishes with a warning when the login cannot be detected safely', async () => {
    const rt = await runtimeWith(LOGIN_UNDETECTABLE);
    const dash = await startDashboard(rt.home);
    await registerRepository(rt);
    await completeSteps(rt, ['basics', 'harnesses', 'github', 'project', 'preset', 'concurrency']);

    const page = text(await dash.html('/setup/verification'));
    expect(page).toContain('Claude Code login warning');
    expect(page).toContain('could not be detected safely');
    expect(await cli(rt, ['doctor'])).toMatch(/unknown +Claude Code login/);
    expect((await next(dash, rt, 'verification')).location).toBe('/setup');
    expect(await onboarding(rt)).toMatchObject({ finished: true });
  });
});
