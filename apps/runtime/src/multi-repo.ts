/**
 * Multi-repo delivery (ADR-0052, ADR-0066): the Job's stored Delivery Order
 * and the sibling PRs each Repository's PR body lists. Read from the rows the
 * runtime wrote; nothing is regenerated.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  DeliveryOrderSchema,
  PullRequestStateSchema,
  type DeliveryOrder,
  type PullRequestBodyInput,
} from '@factory/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

type PullRequestRow = typeof schema.pullRequests.$inferSelect;

/** The Delivery Order stored with the Job's Plan (ADR-0065); `null` before a Plan. */
export function storedDeliveryOrder(tx: Tx | FactoryDb, jobId: string): DeliveryOrder | null {
  const job = tx
    .select({ order: schema.jobs.deliveryOrderJson })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  return job?.order == null ? null : DeliveryOrderSchema.parse(JSON.parse(job.order));
}

/** The Job's current PR of each Repository: one the factory closed and replaced (`new_pr`) is not. */
export function currentPullRequestsOf(tx: Tx | FactoryDb, jobId: string): PullRequestRow[] {
  return tx
    .select()
    .from(schema.pullRequests)
    .where(and(eq(schema.pullRequests.jobId, jobId), isNull(schema.pullRequests.replacedById)))
    .orderBy(asc(sql`"pull_requests"."rowid"`))
    .all();
}

export const pullRequestLabel = (pr: Pick<PullRequestRow, 'owner' | 'name' | 'number'>) =>
  `${pr.owner}/${pr.name}#${String(pr.number)}`;

/**
 * What the PR body of `repositoryId`'s PR shows about the Job's other PRs:
 * the Delivery Order with each Repository's current PR. `null` when the Job's
 * Delivery Order has one Repository (or none yet): no section.
 */
export function multiRepositoryOf(
  tx: Tx | FactoryDb,
  jobId: string,
  repositoryId: string,
): PullRequestBodyInput['multiRepository'] {
  const order = storedDeliveryOrder(tx, jobId);
  const self = order?.find((r) => r.repositoryId === repositoryId);
  if (order === null || order.length < 2 || self === undefined) return null;
  const prs = currentPullRequestsOf(tx, jobId);
  const nameOf = (id: string) => order.find((r) => r.repositoryId === id)?.name ?? id;
  return {
    repository: self.name,
    order: order.map((r) => {
      const pr = prs.find((p) => p.repositoryId === r.repositoryId);
      return {
        repository: r.name,
        after: r.after.map(nameOf),
        pullRequest:
          pr === undefined
            ? null
            : {
                label: pullRequestLabel(pr),
                url: pr.url,
                state: PullRequestStateSchema.parse(pr.state),
              },
      };
    }),
  };
}
