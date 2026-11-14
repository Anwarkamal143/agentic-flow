/**
 * The plan approval view (PRODUCT_SPEC §7), read-only: the Specification, the
 * DAG, the affected Repositories, the parallel waves, the risks, the human
 * decision points and the estimate, all as `GET /v1/jobs/:id/plan` derives
 * them. The decision is made in the Inbox (ADR-0022); this view links there.
 */
import {
  SpecificationProposalSchema,
  type Approval,
  type PlanView,
  type SpecificationProposal,
} from '@factory/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Field, State } from '@/components/job-sections';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime, humanize } from '@/lib/format';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function List({ items, empty }: { items: readonly string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

/** Where this Plan's decision stands, and the way to make it. */
export function PlanDecision({ approval }: { approval: Approval | null }) {
  if (approval === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No plan approval item: this Plan was not held for a human (planApproval: skip).
      </p>
    );
  }
  if (approval.state === 'open') {
    return (
      <p className="text-sm">
        Waiting for a decision.{' '}
        <Link href={`/inbox/${approval.id}`} className="font-medium underline underline-offset-4">
          Approve or reject it in the Inbox
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="text-sm">
      <Link href={`/inbox/${approval.id}`} className="underline underline-offset-4">
        Plan approval
      </Link>{' '}
      {humanize(approval.state)}
      {approval.decision !== null &&
        `: ${optionLabel(approval, approval.decision.option)} by ${String(approval.decidedBy)} at ${formatTime(approval.decidedAt)}`}
    </p>
  );
}

function optionLabel(item: Approval, id: string): string {
  return item.options.find((o) => o.id === id)?.label ?? id;
}

function Specification({ plan }: { plan: PlanView }) {
  if (plan.specificationArtifactId === null) {
    return <p className="text-sm text-muted-foreground">No Specification Artifact recorded.</p>;
  }
  const spec = SpecificationProposalSchema.safeParse(plan.specification);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Agent output, validated when stored:{' '}
        <Link
          href={`/artifacts/${plan.specificationArtifactId}`}
          className="font-mono underline underline-offset-4"
        >
          {plan.specificationArtifactId}
        </Link>
      </p>
      {spec.success ? (
        <SpecificationBody spec={spec.data} />
      ) : (
        <>
          <p className="text-sm text-warning">
            Not in the Specification shape this dashboard knows; shown as stored.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(plan.specification, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function SpecificationBody({ spec }: { spec: SpecificationProposal }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="text-muted-foreground">Problem: </span>
        {spec.problem}
      </p>
      <p>
        <span className="text-muted-foreground">Objective: </span>
        {spec.objective}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">In scope</p>
          <List items={spec.scope} empty="Nothing listed." />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Out of scope</p>
          <List items={spec.outOfScope} empty="Nothing listed." />
        </div>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Requirements</p>
        <List items={spec.requirements.map((r) => `${r.code}: ${r.text}`)} empty="None." />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Acceptance criteria</p>
        <List
          items={spec.acceptanceCriteria.map(
            (c) => `${c.code} (${c.mandatory ? 'mandatory' : 'optional'}): ${c.text}`,
          )}
          empty="None."
        />
      </div>
    </div>
  );
}

export function PlanViewCard({ plan }: { plan: PlanView }) {
  const repoName = new Map(plan.repositories.map((r) => [r.id, r.name]));
  const { estimate } = plan;
  return (
    <Card data-testid="plan" id="plan">
      <CardHeader>
        <CardTitle>Plan</CardTitle>
        <CardDescription>
          Read-only. Plan Artifact{' '}
          <Link
            href={`/artifacts/${plan.planArtifactId}`}
            className="font-mono underline underline-offset-4"
          >
            {plan.planArtifactId}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <PlanDecision approval={plan.approval} />
        <Section title="Specification">
          <Specification plan={plan} />
        </Section>
        <Section title="Tasks and dependencies">
          <ol className="space-y-3">
            {plan.tasks.map((t) => (
              <li key={t.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{t.key}</span>
                  <span className="font-medium">{t.title}</span>
                  <State value={t.state} />
                  <Badge variant={t.risk === 'low' ? 'secondary' : 'warning'}>risk {t.risk}</Badge>
                </div>
                <p className="mt-1 text-sm">{t.objective}</p>
                <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Repository">{repoName.get(t.repositoryId) ?? t.repositoryId}</Field>
                  <Field label="Dependencies">
                    {t.key} depends on{' '}
                    {t.dependsOn.length === 0 ? 'nothing' : t.dependsOn.join(', ')}
                  </Field>
                  <Field label="Covers">
                    {t.acceptance.length === 0 ? 'no criteria' : t.acceptance.join(', ')}
                  </Field>
                  <Field label="Caps">
                    {t.maxAttempts} attempts, {t.maxRetries} retries
                  </Field>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  Writable: <code className="font-mono">{t.writable.join(', ')}</code>
                </p>
              </li>
            ))}
          </ol>
        </Section>
        <Section title="Affected repositories">
          <List items={plan.repositories.map((r) => r.name)} empty="None." />
        </Section>
        <Section title="Runs in parallel">
          <List
            items={plan.parallel.map((wave, i) => `Wave ${String(i + 1)}: ${wave.join(', ')}`)}
            empty="No Tasks."
          />
        </Section>
        <Section title="Risks">
          <PlanRisks plan={plan} />
        </Section>
        <Section title="Human decision points">
          <List items={plan.decisionPoints.map((d) => d.description)} empty="None." />
        </Section>
        <Section title="Estimate">
          <List
            items={[
              `${String(estimate.taskCount)} Task${estimate.taskCount === 1 ? '' : 's'}`,
              `${String(estimate.attempts.min)}–${String(estimate.attempts.max)} Attempts (${estimate.attempts.label})`,
              `Cost unknown: ${estimate.cost.reason}`,
            ]}
            empty="No estimate."
          />
        </Section>
        <span data-testid="plan-end" hidden />
      </CardContent>
    </Card>
  );
}

/** The triage risk and every Task's, as recorded. */
export function PlanRisks({ plan }: { plan: PlanView }) {
  return (
    <List
      items={[
        `Triage risk ${plan.triageRisk ?? 'unknown (no triage recorded)'}`,
        ...plan.tasks.map((t) => `${t.key}: ${t.risk}`),
      ]}
      empty="None recorded."
    />
  );
}
