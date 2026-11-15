import type { GitHubState } from '@factory/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';

/** The runtime could not be reached: say why, and how to fix it. */
export function RuntimeUnavailableNotice({ message }: { message: string }) {
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>The factory runtime is unavailable</CardTitle>
        <CardDescription>Nothing can be shown until the dashboard can reach it.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}

/**
 * The GitHub-wide pause a rate limit set (ADR-0045), as the runtime persisted
 * it. Capacity, not failure: nothing is shown while there is none.
 */
export function GitHubPauseNotice({ github }: { github: GitHubState }) {
  const pause = github.pause;
  if (pause === null) return null;
  return (
    <Card role="status" data-testid="github-pause">
      <CardHeader>
        <CardTitle>
          GitHub calls are paused until{' '}
          <time dateTime={pause.pausedUntil}>{formatTime(pause.pausedUntil)}</time>
        </CardTitle>
        <CardDescription>
          GitHub rate limited the factory (HTTP {pause.status}) at {formatTime(pause.pausedAt)}.
          Nothing is polled, pushed through the API or merged until the reset; then the calls resume
          on their own. This is capacity, not failure: no Stage Run changes and no Blocker is
          raised.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
