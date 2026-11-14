/**
 * An Inbox Item (PRODUCT_SPEC §10) with everything the operator needs to
 * decide it, and its actions as plain HTML forms (no scripts needed). The
 * forms post to the dashboard's own `/api/inbox/:id/:action`, which calls the
 * runtime server-side (ADR-0022). Options are rendered from the item, so any
 * kind's options show the same way; an agent-proposed option says so.
 */
import { GRANT_DEFAULT, GRANT_MAX, type Approval, type PlanView } from '@factory/domain';
import Link from 'next/link';
import { Field, State } from '@/components/job-sections';
import { PlanRisks } from '@/components/plan-view';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime, humanize } from '@/lib/format';

const EXPIRY: Readonly<Record<Approval['expiresPolicy'], string>> = {
  remain_pending: 'Stays pending until a human decides; never auto-approved.',
};

export interface ItemContext {
  projectName: string | undefined;
  repositoryName: string | undefined;
  /** The Job's plan view, for a `plan` item: its risks are the Plan's. */
  plan: PlanView | null;
  /** Where the browser goes back to after an action. */
  returnTo: string;
}

const button =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function InboxItemCard({ item, context }: { item: Approval; context: ItemContext }) {
  const label = (id: string) => item.options.find((o) => o.id === id)?.label ?? id;
  return (
    <Card data-testid="inbox-item">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Link href={`/inbox/${item.id}`} className="underline-offset-4 hover:underline">
            {item.question}
          </Link>
          <Badge variant="outline">{humanize(item.kind)}</Badge>
          <State value={item.state} />
          {item.deferred && <Badge variant="secondary">Deferred</Badge>}
        </CardTitle>
        <CardDescription>
          <Link href={`/jobs/${item.jobId}`} className="underline-offset-4 hover:underline">
            {item.jobTitle}
          </Link>{' '}
          · <span className="font-mono text-xs">{item.id}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Project">
            {context.projectName ?? 'unknown'}{' '}
            <span className="font-mono text-xs">{item.projectId}</span>
          </Field>
          <Field label="Repository">
            {context.repositoryName ?? 'unknown'}{' '}
            <span className="font-mono text-xs">{item.repositoryId}</span>
          </Field>
          <Field label="Where">
            {item.stageId === null ? 'No Stage' : `Stage ${item.stageId}`}
            {item.taskId !== null && ` · Task ${item.taskId}`}
          </Field>
          <Field label="Opened">
            {formatTime(item.createdAt)} · Requested by {item.requestedBy}
          </Field>
        </dl>
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Why it needs you</p>
          <p>{item.why}</p>
        </div>
        {item.questions !== null && <Questions item={item} />}
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Options</p>
          <ul className="space-y-1">
            {item.options.map((o) => (
              <li key={o.id}>
                <span className="font-medium">{o.label}</span>
                {o.agentProposed && (
                  <Badge variant="warning" className="ml-2">
                    proposed by an agent
                  </Badge>
                )}
                {item.recommended === o.id && (
                  <Badge variant="success" className="ml-2">
                    recommended
                  </Badge>
                )}
                <span className="text-muted-foreground"> — {o.description}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">Recommended: {item.recommended ?? 'none'}</p>
        </div>
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Risks</p>
          {item.kind === 'plan' && context.plan !== null ? (
            <PlanRisks plan={context.plan} />
          ) : (
            <p className="text-muted-foreground">None recorded for this item.</p>
          )}
        </div>
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Evidence</p>
          {item.evidence.length === 0 ? (
            <p className="text-muted-foreground">None attached.</p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {item.evidence.map((a) => (
                <li key={a}>
                  <Link
                    href={`/artifacts/${a}`}
                    className="font-mono text-xs underline underline-offset-4"
                  >
                    {a}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {item.kind === 'plan' && (
            <p className="mt-1">
              <Link href={`/jobs/${item.jobId}#plan`} className="underline underline-offset-4">
                Review the Plan
              </Link>
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {EXPIRY[item.expiresPolicy]} Version {item.version}.
        </p>
        {item.state === 'open' ? (
          item.kind === 'question' ? (
            <AnswerForm item={item} returnTo={context.returnTo} />
          ) : (
            <ItemActions item={item} returnTo={context.returnTo} />
          )
        ) : (
          <p className="text-sm">
            {item.decision === null
              ? `This item is ${humanize(item.state)}.`
              : `Decided: ${label(item.decision.option)}${item.decision.grant === undefined ? '' : ` +${String(item.decision.grant)}`} by ${String(item.decidedBy)} at ${formatTime(item.decidedAt)}`}
            {item.decision?.comment != null && (
              <span className="block text-muted-foreground">Comment: {item.decision.comment}</span>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** A `question` item's questions, each labelled as the agent's, with the answers once given. */
function Questions({ item }: { item: Approval }) {
  const answers = item.decision?.answers ?? [];
  return (
    <div className="text-sm">
      <p className="text-xs text-muted-foreground">
        Questions{' '}
        <Badge variant="warning" className="ml-1">
          proposed by an agent
        </Badge>
      </p>
      <ol className="space-y-2" data-testid="questions">
        {(item.questions ?? []).map((q) => {
          const a = answers.find((x) => x.questionId === q.id);
          return (
            <li key={q.id}>
              <span className="font-mono text-xs">{q.id}</span>{' '}
              <Badge variant={q.blocking ? 'outline' : 'secondary'}>
                {q.blocking ? 'blocking' : 'optional'}
              </Badge>
              {q.source === 'scope_change_request' && (
                <Badge variant="outline" className="ml-1">
                  scope change request
                </Badge>
              )}{' '}
              {q.text}
              {q.paths.length > 0 && (
                <span className="block text-muted-foreground">
                  Paths asked for (never granted): {q.paths.join(', ')}
                </span>
              )}
              {q.options.length > 0 && (
                <span className="block text-muted-foreground">
                  Options: {q.options.join(' · ')}
                  {q.recommended !== null && ` (recommended by the agent: ${q.recommended})`}
                </span>
              )}
              {item.decision !== null && (
                <span className="block">
                  Answer:{' '}
                  {a === undefined
                    ? 'not answered'
                    : a.option !== undefined
                      ? `option ${a.option}`
                      : a.text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A `question` item's answer form: per question, its offered options (the
 * agent's) or your own words, then one submit (`answerQuestion`). It carries
 * the version the page was rendered with and the asking Attempt.
 */
function AnswerForm({ item, returnTo }: { item: Approval; returnTo: string }) {
  const version = String(item.version);
  return (
    <div className="flex flex-wrap items-end gap-4 border-t pt-4">
      <form
        method="post"
        action={`/api/inbox/${item.id}/answer`}
        className="w-full space-y-4"
        data-testid="answer-form"
      >
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="subjectRef" value={item.subjectRef} />
        <input type="hidden" name="return" value={returnTo} />
        {(item.questions ?? []).map((q) => (
          <fieldset key={q.id} className="space-y-1 text-sm">
            <legend className="font-medium">
              {q.id}: {q.text} {q.blocking ? '(required)' : '(optional)'}
            </legend>
            {q.options.map((o) => (
              <label key={o} className="mr-4 inline-flex items-center gap-1">
                <input type="radio" name={`choice.${q.id}`} value={o} required={q.blocking} />
                {o}
                {q.recommended === o && (
                  <span className="text-xs text-muted-foreground">(agent recommends)</span>
                )}
              </label>
            ))}
            {q.options.length > 0 && (
              <label className="mr-4 inline-flex items-center gap-1">
                <input type="radio" name={`choice.${q.id}`} value="__text" />
                My own answer
              </label>
            )}
            <label
              htmlFor={`text-${item.id}-${q.id}`}
              className="block text-xs text-muted-foreground"
            >
              {q.options.length > 0 ? 'Your own answer (with “My own answer”)' : 'Your answer'}
            </label>
            <textarea
              id={`text-${item.id}-${q.id}`}
              name={`text.${q.id}`}
              rows={2}
              maxLength={5000}
              required={q.blocking && q.options.length === 0}
              className="block w-full min-w-72 rounded-md border bg-background p-2 text-sm"
            />
          </fieldset>
        ))}
        <p className="text-xs text-muted-foreground">
          Your answers are guidance for a fresh Attempt on the same Task Branch. They never widen
          the Task’s scope or grant a permission.
        </p>
        <button type="submit" className={`${button} bg-primary text-primary-foreground`}>
          Send answers
        </button>
      </form>
      <form method="post" action={`/api/inbox/${item.id}/${item.deferred ? 'undefer' : 'defer'}`}>
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="return" value={returnTo} />
        <button type="submit" className={button}>
          {item.deferred ? 'Undefer' : 'Defer'}
        </button>
      </form>
    </div>
  );
}

/**
 * The item's actions: one form deciding it (a button per option, with an
 * optional comment, which "Request changes" needs as its feedback), and one
 * deferring or undeferring it. Each carries the version the page was rendered
 * with, and a decision its subject.
 */
function ItemActions({ item, returnTo }: { item: Approval; returnTo: string }) {
  const version = String(item.version);
  const commentId = `comment-${item.id}`;
  // "Request changes" (a Replan or a re-specification) is refused without the comment.
  const changes = item.options.find((o) => o.id === 'request_changes');
  const commentLabel =
    changes === undefined
      ? 'Comment (optional)'
      : `Comment (optional; required with “${changes.label}”, as the ${item.kind === 'plan' ? 'planner’s ' : ''}feedback)`;
  return (
    <div className="flex flex-wrap items-end gap-4 border-t pt-4">
      <form method="post" action={`/api/inbox/${item.id}/decide`} className="space-y-2">
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="subjectRef" value={item.subjectRef} />
        <input type="hidden" name="return" value={returnTo} />
        <label htmlFor={commentId} className="block text-xs text-muted-foreground">
          {commentLabel}
        </label>
        <textarea
          id={commentId}
          name="comment"
          rows={2}
          maxLength={5000}
          className="block w-full min-w-72 rounded-md border bg-background p-2 text-sm"
        />
        {item.options.some((o) => o.id === 'grant') && (
          <div>
            <label htmlFor={`grant-${item.id}`} className="block text-xs text-muted-foreground">
              Grant size (used by “{item.options.find((o) => o.id === 'grant')?.label}”; your
              comment becomes guidance for the next Attempt)
            </label>
            <input
              id={`grant-${item.id}`}
              type="number"
              name="grant"
              min={1}
              max={GRANT_MAX}
              step={1}
              defaultValue={GRANT_DEFAULT}
              className="block w-24 rounded-md border bg-background p-2 text-sm"
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {item.options.map((o) => (
            <button
              key={o.id}
              type="submit"
              name="option"
              value={o.id}
              title={o.description}
              className={`${button} ${item.recommended === o.id ? 'bg-primary text-primary-foreground' : ''}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </form>
      <form method="post" action={`/api/inbox/${item.id}/${item.deferred ? 'undefer' : 'defer'}`}>
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="return" value={returnTo} />
        <button type="submit" className={button}>
          {item.deferred ? 'Undefer' : 'Defer'}
        </button>
      </form>
    </div>
  );
}
