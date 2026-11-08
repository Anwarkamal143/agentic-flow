import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, useFakeHarness } from '../support/factory.js';
import { json } from '../support/api.js';
import { VALID_SCRIPT } from '../support/scripts.js';

/** CPU time (user + system) a process has used so far, in seconds, as `ps` reports it. */
function cpuSeconds(pid: number): number {
  const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  // [[dd-]hh:]mm:ss[.ff]
  const [days, clock] = out.includes('-') ? out.split('-') : ['0', out];
  const parts = (clock ?? '').split(':').map(Number).reverse();
  const [s = 0, m = 0, h = 0] = parts;
  return Number(days) * 86_400 + h * 3_600 + m * 60 + s;
}

describe('an idle runtime', () => {
  it('does not busy-loop its schedulers when there is no work', async () => {
    const home = await initializedHome();
    useFakeHarness(home, VALID_SCRIPT); // both schedulers run only with a Harness configured
    const rt = await startRuntime(home);
    const { pid } = await json<{ pid: number }>(rt.request('/v1/status'));
    await new Promise((r) => setTimeout(r, 1_000)); // past startup

    const before = cpuSeconds(pid);
    await new Promise((r) => setTimeout(r, 3_000));
    const used = cpuSeconds(pid) - before;

    // A busy loop burns a full core: ~3 s here. Polling once a second is near zero.
    expect(used, `CPU seconds used in 3 s idle`).toBeLessThan(0.5);
  });
});
