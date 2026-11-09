import type {
  AcceptanceCriterion,
  Attempt,
  AttemptFinding,
  Blocker,
  Evidence,
  Finding,
  Job,
  Review,
  Task,
} from '@factory/domain';
import { SECURITY_TIER_LABELS } from '@factory/domain';
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

function State({ value }: { value: string }) {
  return <Badge variant={stateVariant(value)}>{humanize(value)}</Badge>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
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
          <Field label="Repository">
            <code className="font-mono text-xs">{job.repositoryId}</code>
          </Field>
          <Field label="Created">
            {formatTime(job.createdAt)} by {job.createdBy}
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
      <VerificationRuns attempt={a} />
      <EvidenceTable evidence={a.evidence} />
      {gateFindings.length > 0 && <Findings title="Gate Findings" findings={gateFindings} />}
      {reviews.map((r) => (
        <ReviewPanel key={r.id} review={r} attempt={a} />
      ))}
    </section>
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
