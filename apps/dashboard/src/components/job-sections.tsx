import type {
  AcceptanceCriterion,
  Attempt,
  AttemptFinding,
  Blocker,
  Evidence,
  Finding,
  Job,
  JobRepository,
  PullRequestRecord,
  Review,
  Task,
} from '@factory/domain';
import { emptyDeliveryNote, SECURITY_TIER_LABELS } from '@factory/domain';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatDuration,
  formatTime,
  humanize,
  shortSha,
  stateVariant,
  usageLabels,
} from '@/lib/format';

export function State({ value }: { value: string }) {
  return <Badge variant={stateVariant(value)}>{humanize(value)}</Badge>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** A Job's Repositories by name, each titled with its id. */
export function Repositories({ repositories }: { repositories: JobRepository[] }) {
  return (
    <span className="flex flex-wrap gap-x-2">
      {repositories.map((r) => (
        <code key={r.id} title={r.id} className="font-mono text-xs">
          {r.name}
        </code>
      ))}
    </span>
  );
}

function Sha({ value }: { value: string | null }) {
  return (
    <code className="font-mono text-xs" title={value ?? undefined}>
      {shortSha(value)}
    </code>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function BlockerNote({ blocker }: { blocker: Blocker }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="font-medium">
        Blocked ({blocker.kind}): {humanize(blocker.reason)}
      </p>
      <p className="mt-1">{blocker.detail}</p>
      <p className="mt-1 text-muted-foreground">Needed: {blocker.requiredAction}</p>
    </div>
  );
}

export function JobOverview({ job }: { job: Job }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-xl">{job.title}</CardTitle>
          <State value={job.status} />
        </div>
        <CardDescription className="font-mono text-xs">{job.id}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Current stage">{job.currentStage}</Field>
          <Field label="Type">{job.type}</Field>
          <Field label="Repositories">
            <Repositories repositories={job.repositories} />
          </Field>
          <Field label="Created">
            {formatTime(job.createdAt)} by {job.createdBy}
          </Field>
          <Field label="Replans">
            {job.replans.used} of {job.replans.max} used
            {job.replanRequested ? ' · replan requested, waiting for the Attempts in flight' : ''}
          </Field>
        </dl>
        {job.description === '' ? (
          <Empty>No description.</Empty>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{job.description}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function StageRuns({ job }: { job: Job }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stages</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {job.stageRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{run.stageId}</TableCell>
                <TableCell>
                  <State value={run.state} />
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatTime(run.startedAt)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatTime(run.finishedAt)}</TableCell>
                <TableCell>
                  {run.failure !== null && (
                    <span>
                      {humanize(run.failure.reason)}: {run.failure.message}
                    </span>
                  )}
                  {run.blocker !== null && <BlockerNote blocker={run.blocker} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * The Job's pull requests (ADR-0036, ADR-0037), from the rows the runtime
 * recorded: never read live from GitHub on page load. Each shows the Merge
 * Gate the poller last evaluated, each check with its link, and when GitHub
 * was last polled. Shown only once one exists.
 */
export function PullRequests({ pullRequests }: { pullRequests: PullRequestRecord[] }) {
  if (pullRequests.length === 0) return null;
  return (
    <Card data-testid="pull-requests">
      <CardHeader>
        <CardTitle>Pull requests</CardTitle>
        <CardDescription>As recorded by the factory; not read live from GitHub.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pull request</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Branches</TableHead>
              <TableHead>Head</TableHead>
              <TableHead>Merge</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pullRequests.map((pr) => (
              <TableRow key={pr.id} data-testid={`pull-request-${String(pr.number)}`}>
                <TableCell>
                  <a
                    className="underline underline-offset-2"
                    href={pr.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {`${pr.owner}/${pr.name}#${String(pr.number)}`}
                  </a>
                  {pr.adopted ? (
                    <span className="ml-2 text-xs text-muted-foreground">adopted on recovery</span>
                  ) : null}
                  {pr.replacedByNumber === null ? null : (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {`replaced by #${String(pr.replacedByNumber)}`}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <State value={pr.state} />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {pr.headBranch} → {pr.baseBranch}
                </TableCell>
                <TableCell className="font-mono text-xs">{shortSha(pr.headSha)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {pr.mergeSha === null ? 'not merged' : shortSha(pr.mergeSha)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pullRequests
          .filter((pr) => pr.changedFiles === 0)
          .map((pr) => (
            <p
              key={pr.id}
              className="text-sm font-medium"
              data-testid={`empty-delivery-${String(pr.number)}`}
            >
              {`#${String(pr.number)}: ${emptyDeliveryNote(pr.headSha, pr.baseSha)}`}
            </p>
          ))}
        {pullRequests.map((pr) => (
          <MergeGateView key={pr.id} pr={pr} />
        ))}
      </CardContent>
    </Card>
  );
}

/** One PR's Merge Gate and checks, as the poller last recorded them. */
function MergeGateView({ pr }: { pr: PullRequestRecord }) {
  const name = `${pr.owner}/${pr.name}#${String(pr.number)}`;
  return (
    <div className="space-y-2" data-testid={`merge-gate-${String(pr.number)}`}>
      <p className="text-sm font-medium">
        Merge Gate of {name}: {pr.gate === null ? 'not evaluated yet' : pr.gate.verdict}
      </p>
      <p className="text-xs text-muted-foreground">
        Last polled{' '}
        {pr.lastPolledAt === null ? 'never (not polled yet)' : formatTime(pr.lastPolledAt)}
        {pr.gateEvaluatedAt === null ? null : `; gate evaluated ${formatTime(pr.gateEvaluatedAt)}`}
      </p>
      {pr.gate === null ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Condition</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pr.gate.conditions.map((c) => (
              <TableRow key={c.id} data-testid={`gate-${c.id}`}>
                <TableCell>{c.label}</TableCell>
                <TableCell>
                  <State value={c.status} />
                </TableCell>
                <TableCell className="text-xs">{c.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-sm font-medium">Checks on {shortSha(pr.headSha)}</p>
      {pr.checks.length === 0 ? (
        <Empty>None reported.</Empty>
      ) : (
        <ul className="space-y-1 text-sm">
          {pr.checks.map((c) => (
            <li key={`${c.source}:${c.name}`} data-testid={`check-${c.name}`}>
              <span className="font-mono">{c.name}</span> <State value={c.outcome} />{' '}
              {c.url !== null && /^https?:\/\//.test(c.url) ? (
                <a
                  className="underline underline-offset-2"
                  href={c.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  details
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AcceptanceCriteria({ criteria }: { criteria: AcceptanceCriterion[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Acceptance Criteria</CardTitle>
      </CardHeader>
      <CardContent>
        {criteria.length === 0 ? (
          <Empty>None yet: the Specification hasn&apos;t been accepted.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Criterion</TableHead>
                <TableHead>Mandatory</TableHead>
                <TableHead>Verification</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {criteria.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell>{c.text}</TableCell>
                  <TableCell>{c.mandatory ? 'yes' : 'no'}</TableCell>
                  <TableCell>{c.verification}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function Tasks({
  tasks,
  attempts,
  reviews,
}: {
  tasks: Task[];
  attempts: Attempt[];
  reviews: Review[];
}) {
  if (tasks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty>None yet: the Plan hasn&apos;t been accepted.</Empty>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Tasks</h2>
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          attempts={attempts.filter((a) => a.taskId === task.id).sort((a, b) => a.n - b.n)}
          reviews={reviews}
        />
      ))}
    </div>
  );
}

function TaskCard({
  task,
  attempts,
  reviews,
}: {
  task: Task;
  attempts: Attempt[];
  reviews: Review[];
}) {
  return (
    <Card data-testid="task">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>
            <span className="font-mono text-sm text-muted-foreground">{task.key}</span> {task.title}
          </CardTitle>
          <State value={task.state} />
          {task.kind === 'integration' && (
            <span data-testid="integration-task" className="text-xs text-muted-foreground">
              Integration Task: created by the factory, not part of the Plan
            </span>
          )}
          {task.cancelReason !== null && (
            <span className="text-xs text-muted-foreground">
              Cancelled by {humanize(task.cancelReason)}
            </span>
          )}
        </div>
        <CardDescription>{task.objective}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Covers">{task.acceptance.join(', ') || 'no criteria'}</Field>
          <Field label="Writable">
            <code className="font-mono text-xs">{task.scope.writable.join(' ')}</code>
          </Field>
          <Field label="Attempts">
            {attempts.length} (Rework cap {task.maxAttempts}, Retries {task.maxRetries})
          </Field>
          <Field label="Risk">{task.risk}</Field>
        </dl>
        {task.blocker !== null && <BlockerNote blocker={task.blocker} />}
        {attempts.length === 0 ? (
          <Empty>No Attempt has started.</Empty>
        ) : (
          attempts.map((a) => (
            <AttemptPanel
              key={a.id}
              attempt={a}
              reviews={reviews.filter((r) => r.attemptId === a.id)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function AttemptPanel({ attempt: a, reviews }: { attempt: Attempt; reviews: Review[] }) {
  const usage = usageLabels(a.usage);
  const tier = SECURITY_TIER_LABELS[a.tier];
  const gateFindings = a.findings.filter((f) => f.source === 'gate');
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      data-testid="attempt"
      aria-label={`Attempt ${String(a.n)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Attempt {a.n}</h3>
        <Badge variant="outline">{a.cause}</Badge>
        <State value={a.state} />
        {a.exitReason !== null && <State value={a.exitReason} />}
        <Badge variant="outline" title={tier.detail}>
          {tier.label}
        </Badge>
      </div>
      {a.exitDetail !== null && <p className="text-sm">{a.exitDetail}</p>}
      <p className="text-xs text-muted-foreground">{tier.detail}</p>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Harness">
          {a.harness.id} {a.harness.version ?? '(version unknown)'}
        </Field>
        <Field label="Base → head">
          <Sha value={a.baseSha} /> → <Sha value={a.headSha} />
        </Field>
        <Field label="Commits">
          {a.commits.length}
          {a.wipCommit !== null && ' (incl. a factory WIP commit)'}
        </Field>
        <Field label="Started / finished">
          {formatTime(a.startedAt)} / {formatTime(a.finishedAt)}
        </Field>
        <Field label="Tokens">{usage.tokens}</Field>
        <Field label="Cost">{usage.cost}</Field>
        <Field label="Harness time">{usage.duration}</Field>
        <Field label="Session">
          <code className="font-mono text-xs">{a.sessionRef ?? 'none recorded'}</code>
        </Field>
      </dl>
      {a.protocolViolations.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Protocol violations</p>
          <ul className="list-disc pl-5">
            {a.protocolViolations.map((v, i) => (
              <li key={i}>
                <code className="font-mono text-xs">{v.rule}</code> {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.setupRuns.length > 0 && <SetupRuns attempt={a} />}
      <VerificationRuns attempt={a} />
      <EvidenceTable evidence={a.evidence} />
      {gateFindings.length > 0 && <Findings title="Gate Findings" findings={gateFindings} />}
      {reviews.map((r) => (
        <ReviewPanel key={r.id} review={r} attempt={a} />
      ))}
    </section>
  );
}

/** The Repository's setup command in this Attempt's Worktree (ADR-0047). */
function SetupRuns({ attempt }: { attempt: Attempt }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">
        Setup (run by the factory on this machine, lifecycle scripts off)
      </h4>
      <Table data-testid="setup-runs">
        <TableHeader>
          <TableRow>
            <TableHead>Command</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Worktree size</TableHead>
            <TableHead>Head</TableHead>
            <TableHead>Log</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempt.setupRuns.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <code className="font-mono text-xs">{r.command}</code>
              </TableCell>
              <TableCell>
                {r.passed ? (
                  <Badge variant="success">passed</Badge>
                ) : (
                  <>
                    <Badge variant="destructive">failed</Badge>{' '}
                    <span className="text-xs">{r.failure}</span>
                  </>
                )}
              </TableCell>
              <TableCell>{formatDuration(r.durationMs)}</TableCell>
              <TableCell>
                {r.diskBytes === null ? 'unknown' : `${(r.diskBytes / 2 ** 20).toFixed(1)} MiB`}
              </TableCell>
              <TableCell>
                <Sha value={r.headSha} />
              </TableCell>
              <TableCell>
                <a className="underline" href={`/artifacts/${r.outputArtifactId}`}>
                  log
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VerificationRuns({ attempt }: { attempt: Attempt }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Verification (run by the factory)</h4>
      {attempt.verificationRuns.length === 0 ? (
        <Empty>Not run.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Command</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Head</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempt.verificationRuns.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.key}</TableCell>
                <TableCell>
                  {r.profileCommand === null ? null : (
                    <div className="text-muted-foreground text-xs">
                      profile command{' '}
                      <code className="font-mono">
                        {[r.profileCommand.name, ...r.profileCommand.args].join(' ')}
                      </code>
                    </div>
                  )}
                  <code className="font-mono text-xs">{r.command}</code>
                </TableCell>
                <TableCell>{r.required ? 'yes' : 'no'}</TableCell>
                <TableCell>
                  {r.timedOut ? (
                    <Badge variant="destructive">timed out</Badge>
                  ) : (
                    <Badge variant={r.exitCode === 0 ? 'success' : 'destructive'}>
                      {r.exitCode === null ? 'no exit code' : `exit ${String(r.exitCode)}`}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{formatDuration(r.durationMs)}</TableCell>
                <TableCell>
                  <Sha value={r.headSha} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function EvidenceTable({ evidence }: { evidence: Evidence[] }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Evidence</h4>
      {evidence.length === 0 ? (
        <Empty>None recorded.</Empty>
      ) : (
        <Table data-testid="evidence">
          <TableHeader>
            <TableRow>
              <TableHead>For</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>(head, base)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evidence.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">
                  {e.kind === 'criterion' ? e.criterionCode : e.verificationKey}
                </TableCell>
                <TableCell>
                  <State value={e.verdict} />
                </TableCell>
                <TableCell>{e.source}</TableCell>
                <TableCell>{e.detail}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Sha value={e.headSha} />, <Sha value={e.baseSha} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ReviewPanel({ review: r, attempt }: { review: Review; attempt: Attempt }) {
  // A review holds only for the (head, base) it ran against (CLAUDE.md "Gates are tied to SHAs").
  const stale = r.headSha !== attempt.headSha || r.baseSha !== attempt.baseSha;
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="review">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">Independent review</h4>
        <State value={r.outcome} />
        {stale && <Badge variant="warning">stale: the Attempt&apos;s head or base changed</Badge>}
        {r.reanchoredFrom !== null && (
          <Badge variant="outline" data-testid="review-reanchored">
            re-anchored from {r.reanchoredFrom}: the base merge-in left the diff unchanged, no
            reviewer ran
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {r.reviewer.harnessId} {r.reviewer.version ?? '(version unknown)'} · at{' '}
          <Sha value={r.headSha} /> on <Sha value={r.baseSha} /> · {formatTime(r.createdAt)}
        </span>
      </div>
      <p className="text-sm">{r.summary}</p>
      {r.findings.length === 0 ? (
        <Empty>No Findings.</Empty>
      ) : (
        <Findings title="Findings" findings={r.findings} />
      )}
    </div>
  );
}

function Findings({ title, findings }: { title: string; findings: (Finding | AttemptFinding)[] }) {
  return (
    <div>
      <h5 className="mb-1 text-sm font-medium">{title}</h5>
      <ul className="space-y-2">
        {findings.map((f) => (
          <li key={f.id} className="rounded-md border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={f.blocking ? 'destructive' : 'secondary'}>
                {f.severity}
                {f.blocking ? ', blocking' : ''}
              </Badge>
              <Badge variant="outline">{f.faultOrigin}</Badge>
              {'rule' in f && f.rule !== null && (
                <code className="font-mono text-xs">{f.rule}</code>
              )}
              <code className="font-mono text-xs text-muted-foreground">{f.location}</code>
            </div>
            <p className="mt-1">{f.problem}</p>
            {f.recommendation !== '' && (
              <p className="mt-1 text-muted-foreground">Recommendation: {f.recommendation}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
