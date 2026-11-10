import type { Approval } from '@factory/domain';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { InboxItemCard } from '@/components/inbox';
import { LiveRefresh } from '@/components/live';
import { PlanViewCard } from '@/components/plan-view';
import { RuntimeUnavailableNotice } from '@/components/states';
import {
  inboxContext,
  inboxItem,
  RuntimeApiError,
  RuntimeUnavailable,
  type InboxContext,
} from '@/lib/runtime';

/** One Inbox Item; a `plan` item shows the read-only Plan it decides under its actions. */
export default async function InboxItemPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let item: Approval;
  let context: InboxContext;
  try {
    item = await inboxItem(id);
    context = await inboxContext([item]);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) notFound();
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  const plan = context.plans.get(item.jobId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Inbox Item</h1>
        <LiveRefresh />
      </div>
      <InboxItemCard
        item={item}
        context={{
          projectName: context.projects.get(item.projectId),
          repositoryName: context.repositories.get(item.repositoryId),
          plan,
          returnTo: `/inbox/${item.id}`,
        }}
      />
      {item.kind === 'plan' && plan !== null && (
        <>
          {plan.planArtifactId !== item.subjectRef && (
            <p role="alert" className="text-sm text-warning">
              This item decides Plan {item.subjectRef}; the Job’s newest Plan, shown below, is{' '}
              {plan.planArtifactId}.
            </p>
          )}
          <PlanViewCard plan={plan} />
        </>
      )}
    </div>
  );
}
