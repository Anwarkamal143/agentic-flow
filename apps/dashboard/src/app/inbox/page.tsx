import type { Approval } from '@factory/domain';
import Link from 'next/link';
import { connection } from 'next/server';
import { InboxItemCard } from '@/components/inbox';
import { LiveRefresh } from '@/components/live';
import { RuntimeUnavailableNotice } from '@/components/states';
import { inbox, inboxContext, RuntimeUnavailable, type InboxContext } from '@/lib/runtime';

/**
 * The Inbox (PRODUCT_SPEC §10, ADR-0022): what needs the operator. By default
 * the open items that aren't deferred; `?all=true` shows every item. Kept live
 * as every page is: an event re-renders it from the API.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const all = (await searchParams)['all'] === 'true';
  let items: Approval[];
  let context: InboxContext;
  try {
    items = await inbox(all);
    context = await inboxContext(items);
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  const returnTo = all ? '/inbox?all=true' : '/inbox';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <LiveRefresh />
        <Link
          href={all ? '/inbox' : '/inbox?all=true'}
          className="ml-auto text-sm underline-offset-4 hover:underline"
        >
          {all ? 'Show only what needs me' : 'Show every item (deferred and closed too)'}
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border p-5 text-sm text-muted-foreground">
          {all ? 'No Inbox Items yet.' : 'Nothing needs you right now.'}
        </p>
      ) : (
        items.map((item) => (
          <InboxItemCard
            key={item.id}
            item={item}
            context={{
              projectName: context.projects.get(item.projectId),
              repositoryName: context.repositories.get(item.repositoryId),
              plan: context.plans.get(item.jobId) ?? null,
              returnTo,
            }}
          />
        ))
      )}
    </div>
  );
}
