/**
 * A Harness that never sees or returns a secret value (ADR-0011): the prompt
 * is redacted before the Run starts (no secret is passed to a Harness), and the
 * Run's output and events are redacted before the runtime reads them. The
 * stores redact again on write; this keeps secrets out of memory too.
 */
import type { Redactor } from '@factory/domain';
import type { AgentHarness, HarnessEvent, HarnessRun, HarnessStartInput } from './index.js';

export function redactingHarness(inner: AgentHarness, redact: Redactor): AgentHarness {
  const wrap = (run: HarnessRun): HarnessRun => ({
    executionId: run.executionId,
    ...(run.sessionRef === undefined ? {} : { sessionRef: run.sessionRef }),
    ...(run.pid === undefined ? {} : { pid: run.pid }),
    ...(run.process === undefined ? {} : { process: run.process }),
    events: redactEvents(run.events, redact),
    result: run.result.then((r) => ({ ...r, output: redact(r.output) })),
    cancel: () => run.cancel(),
  });
  const input = (i: HarnessStartInput): HarnessStartInput => ({ ...i, prompt: redact(i.prompt) });
  const resume = inner.resume?.bind(inner);
  const reattach = inner.reattach?.bind(inner);
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    detect: () => inner.detect(),
    start: async (i) => wrap(await inner.start(input(i))),
    ...(reattach === undefined
      ? {}
      : {
          reattach: async (i) => {
            const run = await reattach(i);
            return run === undefined ? undefined : wrap(run);
          },
        }),
    ...(resume === undefined
      ? {}
      : {
          resume: async (sessionRef, message, opts) =>
            wrap(await resume(sessionRef, redact(message), opts)),
        }),
  };
}

async function* redactEvents(
  events: AsyncIterable<HarnessEvent>,
  redact: Redactor,
): AsyncGenerator<HarnessEvent> {
  for await (const e of events) {
    if (e.kind === 'text') yield { kind: 'text', text: redact(e.text) };
    else if (e.kind === 'progress') yield { kind: 'progress', message: redact(e.message) };
    else yield e;
  }
}
