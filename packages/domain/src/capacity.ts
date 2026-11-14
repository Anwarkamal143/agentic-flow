/**
 * Task concurrency (ARCHITECTURE §12 step 2, ADR-0020): capacity tokens.
 *
 * A token is a lease row `(resource_kind, resource_id)` whose id is a slot
 * number, so the table's primary key makes a slot impossible to hold twice:
 * `capacity.global` `<i>`, `capacity.repository` `<repository-id>:<i>` and
 * `capacity.job` `<job-id>:<i>`. A claim takes one token of each kind, in the
 * same transaction as the Task lease. No I/O.
 */

/** The global limit when `config.json` sets none. */
export const DEFAULT_GLOBAL_CONCURRENCY = 3;

export const CAPACITY_RESOURCE = {
  global: 'capacity.global',
  repository: 'capacity.repository',
  job: 'capacity.job',
} as const;

export interface CapacityLimits {
  /** `config.json` `concurrency.global`. */
  global: number;
  /** The claiming Job's Effective Configuration `concurrency.perRepository`. */
  perRepository: number;
  /** The claiming Job's Effective Configuration `concurrency.perJob`. */
  perJob: number;
}

export interface HeldCapacityToken {
  resourceKind: string;
  resourceId: string;
}

export type CapacityDecision =
  | { kind: 'granted'; tokens: HeldCapacityToken[] }
  | { kind: 'full'; limit: 'global' | 'repository' | 'job'; held: number; max: number };

/**
 * Whether a Task of `jobId` on `repositoryId` may be claimed now, and the
 * tokens it takes: the lowest free slot under each limit. A limit is full
 * when that many tokens of its scope are held, counting slots at or above
 * this Job's limit that a Job with a higher limit holds.
 */
export function claimCapacity(input: {
  limits: CapacityLimits;
  repositoryId: string;
  jobId: string;
  held: readonly HeldCapacityToken[];
}): CapacityDecision {
  const scopes = [
    { limit: 'global', kind: CAPACITY_RESOURCE.global, prefix: '', max: input.limits.global },
    {
      limit: 'repository',
      kind: CAPACITY_RESOURCE.repository,
      prefix: `${input.repositoryId}:`,
      max: input.limits.perRepository,
    },
    {
      limit: 'job',
      kind: CAPACITY_RESOURCE.job,
      prefix: `${input.jobId}:`,
      max: input.limits.perJob,
    },
  ] as const;
  const tokens: HeldCapacityToken[] = [];
  for (const scope of scopes) {
    const used = new Set(
      input.held
        .filter((t) => t.resourceKind === scope.kind && t.resourceId.startsWith(scope.prefix))
        .map((t) => t.resourceId.slice(scope.prefix.length)),
    );
    if (used.size >= scope.max) {
      return { kind: 'full', limit: scope.limit, held: used.size, max: scope.max };
    }
    // Fewer than `max` held, so a slot below `max` is free.
    let slot = 0;
    while (used.has(String(slot))) slot++;
    tokens.push({ resourceKind: scope.kind, resourceId: `${scope.prefix}${String(slot)}` });
  }
  return { kind: 'granted', tokens };
}
