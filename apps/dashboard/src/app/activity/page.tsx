import { MODEL_UNKNOWN_LABEL, type Activity, type AttemptTail } from '@factory/domain';
import Link from 'next/link';
import { connection } from 'next/server';
import { LiveTail } from '@/components/activity';
import { LiveRefresh } from '@/components/live';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime, humanize, stateVariant } from '@/lib/format';
import { activity, attemptTail, RuntimeApiError, RuntimeUnavailable } from '@/lib/runtime';

/**
 * Live activity (PRODUCT_SPEC §11, ADR-0018): what's running right now. The
 * running Attempts are persisted state, re-rendered on each event (SSE); only
 * each Attempt's output tail is polled, by {@link LiveTail}.
 */
export default async function ActivityPage() {
  await connection();
  let current: Activity;
  let tails: (AttemptTail | undefined)[];
  try {
    current = await activity();
    tails = await Promise.all(
      current.attempts.map((a) =>
        attemptTail(a.attemptId).catch((err: unknown) => {
          // Ended (and gone) between the two reads: the next event re-renders the page.
          if (err instanceof RuntimeApiError && err.status === 404) return undefined;
          throw err;
        }),
      ),
    );
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Live activity</h1>
        <LiveRefresh />
        <span className="text-xs text-muted-foreground">As of {formatTime(current.at)}</span>
      </div>
      {current.attempts.length === 0 ? (
        <p className="rounded-xl border p-5 text-sm text-muted-foreground">
          Nothing is running right now.
        </p>
      ) : (
        current.attempts.map((a, i) => {
          const tail = tails[i];
          const harness =
            a.harness.version === null ? a.harness.id : `${a.harness.id} ${a.harness.version}`;
          return (
            <Card key={a.attemptId} data-testid="running-attempt">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span>
                    {a.task.key} · Attempt {a.n}
                  </span>
                  <Badge variant={stateVariant(a.state)}>{humanize(a.state)}</Badge>
                  <Badge variant="outline" title={a.tierDetail}>
                    {a.tierLabel}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  <Link href={`/jobs/${a.job.id}`} className="underline-offset-4 hover:underline">
                    {a.job.title}
                  </Link>{' '}
                  · {a.task.title}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
                  <dt className="text-muted-foreground">Repository</dt>
                  <dd>{a.repository.name}</dd>
                  <dt className="text-muted-foreground">Harness</dt>
                  <dd>{harness}</dd>
                  <dt className="text-muted-foreground">Model</dt>
                  <dd>{a.model ?? MODEL_UNKNOWN_LABEL}</dd>
                  <dt className="text-muted-foreground">Ports</dt>
                  <dd>
                    {a.ports.base}–{a.ports.base + a.ports.size - 1}
                  </dd>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{formatTime(a.startedAt)}</dd>
                  <dt className="text-muted-foreground">Job</dt>
                  <dd className="font-mono text-xs">{a.job.id}</dd>
                </dl>
                <p className="text-xs text-muted-foreground">{a.tierDetail}</p>
                {tail === undefined ? (
                  <p className="text-sm text-muted-foreground">The Attempt has ended.</p>
                ) : (
                  <LiveTail attemptId={a.attemptId} initial={tail} />
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
