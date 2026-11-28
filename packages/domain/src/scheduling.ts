/**
 * Fair scheduling across Projects (ARCHITECTURE §12 step 1, ADR-0050). The
 * Task claimer and the proposal-Stage scheduler order their candidates by one
 * function, `priority_weight + agingStep × floor(wait_s / agingIntervalSeconds)
 * − in_flight ÷ project limit` (the penalty is 0 when the limit is unlimited),
 * and a claim of a Job's first work in flight takes a Project slot under
 * `concurrency.perProjectJobs`. Pure; no I/O.
 */
import { z } from 'zod';
import type { ConfigSource } from './config-levels.js';

/** `concurrency.perProjectJobs`: Jobs of one Project with work in flight at once. */
export const ProjectJobLimitSchema = z.union([
  z.number().int().min(1).max(64),
  z.literal('unlimited'),
]);
export type ProjectJobLimit = z.infer<typeof ProjectJobLimitSchema>;

/** The aging constants (Factory Level `scheduling.*`). */
export interface FairnessConstants {
  /** Priority gained per whole interval waited. */
  agingStep: number;
  /** The interval, in seconds. */
  agingIntervalSeconds: number;
}

/** ADR-0050: 0.5 per whole minute, so a `low` candidate overtakes a `normal` one after 2 minutes. */
export const FAIRNESS_DEFAULTS: Readonly<FairnessConstants> = {
  agingStep: 0.5,
  agingIntervalSeconds: 60,
};

/** The Factory Level `scheduling` keys (all optional: unset is the default). */
export const SchedulingConfigSchema = z
  .object({
    agingStep: z.number().min(0).max(10).optional(),
    agingIntervalSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();
export type SchedulingConfig = z.infer<typeof SchedulingConfigSchema>;

/** The constants a Factory Level sets, the rest defaulted. */
export function fairnessConstants(config: SchedulingConfig | undefined): FairnessConstants {
  return {
    agingStep: config?.agingStep ?? FAIRNESS_DEFAULTS.agingStep,
    agingIntervalSeconds: config?.agingIntervalSeconds ?? FAIRNESS_DEFAULTS.agingIntervalSeconds,
  };
}

export function effectivePriority(input: {
  priorityWeight: number;
  waitSeconds: number;
  /** The candidate's Project's Jobs with work in flight now. */
  inFlight: number;
  limit: ProjectJobLimit;
  constants?: FairnessConstants | undefined;
}): number {
  const { agingStep, agingIntervalSeconds } = input.constants ?? FAIRNESS_DEFAULTS;
  const aging = agingStep * Math.floor(Math.max(0, input.waitSeconds) / agingIntervalSeconds);
  const penalty = input.limit === 'unlimited' ? 0 : input.inFlight / input.limit;
  return input.priorityWeight + aging - penalty;
}

/** What the ordering reads of one candidate (a ready Task or a queued proposal Stage Run). */
export interface FairCandidate {
  projectId: string;
  priorityWeight: number;
  /** When it became ready (ISO). */
  readyAt: string;
}

/**
 * `candidates` by effective priority, highest first; ties go to the longer
 * wait, then keep the given order. A Project missing from `limits` is unlimited.
 */
export function fairOrder<C extends FairCandidate>(
  candidates: readonly C[],
  ctx: {
    now: number;
    inFlight: ReadonlyMap<string, number>;
    limits: ReadonlyMap<string, ProjectJobLimit>;
    constants?: FairnessConstants | undefined;
  },
): C[] {
  const scored = candidates.map((c, index) => {
    const readyMs = Date.parse(c.readyAt);
    return {
      c,
      index,
      readyMs,
      score: effectivePriority({
        priorityWeight: c.priorityWeight,
        waitSeconds: (ctx.now - readyMs) / 1000,
        inFlight: ctx.inFlight.get(c.projectId) ?? 0,
        limit: ctx.limits.get(c.projectId) ?? 'unlimited',
        constants: ctx.constants,
      }),
    };
  });
  scored.sort((a, b) => b.score - a.score || a.readyMs - b.readyMs || a.index - b.index);
  return scored.map((s) => s.c);
}

/** The levels that may set `concurrency.perProjectJobs`. */
interface PerProjectJobsLevel {
  concurrency?: { perProjectJobs?: ProjectJobLimit | undefined } | undefined;
}

/**
 * A Project's Job limit: the Project's own, else the Factory Level's, else
 * unlimited. Read at each claim, never frozen into a Job: the limit is shared
 * by every Job of the Project (ADR-0058).
 */
export function resolveProjectJobLimit(
  factory: PerProjectJobsLevel,
  project: PerProjectJobsLevel,
): { value: ProjectJobLimit; source: ConfigSource } {
  const own = project.concurrency?.perProjectJobs;
  if (own !== undefined) return { value: own, source: 'project' };
  const top = factory.concurrency?.perProjectJobs;
  if (top !== undefined) return { value: top, source: 'factory' };
  return { value: 'unlimited', source: 'recipe' };
}

export type ProjectSlotDecision =
  | { kind: 'held' }
  | { kind: 'granted'; resourceId: string }
  | { kind: 'full'; held: number; max: number };

/**
 * Whether a Job's claim fits under its Project's limit. A Job already in
 * flight holds its slot and takes none; a new one gets the lowest free slot
 * (`<project-id>:<i>`), also when the limit is unlimited, so its Jobs in flight
 * are counted. `held`: the resource ids of every Project slot held now.
 */
export function projectSlotDecision(input: {
  projectId: string;
  limit: ProjectJobLimit;
  held: readonly string[];
  jobHoldsSlot: boolean;
}): ProjectSlotDecision {
  if (input.jobHoldsSlot) return { kind: 'held' };
  const prefix = `${input.projectId}:`;
  const used = new Set(
    input.held.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)),
  );
  if (input.limit !== 'unlimited' && used.size >= input.limit) {
    return { kind: 'full', held: used.size, max: input.limit };
  }
  let slot = 0;
  while (used.has(String(slot))) slot++;
  return { kind: 'granted', resourceId: `${prefix}${String(slot)}` };
}
