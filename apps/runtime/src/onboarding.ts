/**
 * The onboarding wizard's record (#114, ADR-0053, ADR-0074): one row holding
 * the last step completed, nothing else. A step's configuration is written by
 * the ordinary APIs (Projects, Repositories, the Factory Level) before its
 * Next; Next here only records the step, in one transaction with its audit
 * row and event. The Project and Repository step needs a registered
 * Repository, and the last step (Finish) needs every mandatory check to pass.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  completeOnboardingStep,
  nextOnboardingStep,
  onboardingChecks,
  ONBOARDING_STEPS,
  OnboardingStepSchema,
  type CompleteOnboardingStepInput,
  type Onboarding,
  type OnboardingCheckInput,
  type OnboardingChecks,
  type OnboardingStep,
} from '@factory/domain';
import { eq, sql } from 'drizzle-orm';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';

const ROW_ID = 'onboarding';
const TARGET = 'onboarding';
const LAST_STEP: OnboardingStep = 'verification';

/** What the finish checks read from the environment: doctor's tools, login and billing. */
export type EnvironmentChecks = () => Promise<Omit<OnboardingCheckInput, 'repositories'>>;

export class OnboardingService {
  constructor(
    private readonly db: FactoryDb,
    private readonly environment: EnvironmentChecks,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  /** Creates the row on the first start (no step completed); does nothing after. */
  ensure(): void {
    this.db
      .insert(schema.onboarding)
      .values({
        id: ROW_ID,
        lastCompletedStep: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  show(): Onboarding {
    return view(readRow(this.db));
  }

  /** The finish checks as they stand now (doctor's probes, the Repository count). */
  async checks(): Promise<OnboardingChecks> {
    const env = await this.environment();
    const checks = onboardingChecks({ ...env, repositories: repositoryCount(this.db) });
    return { checks, canFinish: checks.every((c) => c.status !== 'fail') };
  }

  /** Next (or Finish) on `step`: refused out of order, on a stale version, or while its need is unmet. */
  async complete(input: CompleteOnboardingStepInput, actor: string): Promise<Onboarding> {
    if (input.step === 'project' && repositoryCount(this.db) === 0) {
      throw new ApiFailure(
        409,
        'onboarding_step_incomplete',
        'register a Repository before going on: the factory needs one to work on',
      );
    }
    if (input.step === LAST_STEP) {
      const { checks, canFinish } = await this.checks();
      if (!canFinish) {
        const failing = checks.filter((c) => c.status === 'fail');
        throw new ApiFailure(
          409,
          'onboarding_checks_failed',
          `setup can't finish while a mandatory check fails: ${failing
            .map((c) => `${c.label}: ${c.message}`)
            .join('; ')}`,
        );
      }
    }
    const updated = this.db.transaction(
      (tx) => {
        const row = readRow(tx);
        if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
          throw new ApiFailure(
            409,
            'version_conflict',
            `the wizard is at version ${String(row.version)}, not ${String(input.expectedVersion)}`,
          );
        }
        const result = completeOnboardingStep(row.lastCompleted, input.step);
        if (!result.ok) throw new ApiFailure(409, result.code, result.message);
        if (result.lastCompleted === row.lastCompleted) return view(row);
        const next = {
          lastCompleted: result.lastCompleted,
          version: row.version + 1,
          updatedAt: new Date().toISOString(),
        };
        tx.update(schema.onboarding)
          .set({
            lastCompletedStep: next.lastCompleted,
            version: next.version,
            updatedAt: next.updatedAt,
          })
          .where(eq(schema.onboarding.id, ROW_ID))
          .run();
        record(tx, actor, row.lastCompleted, next);
        return view(next);
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return updated;
  }
}

interface Row {
  lastCompleted: OnboardingStep | null;
  version: number;
  updatedAt: string;
}

function readRow(db: FactoryDb | Tx): Row {
  const row = db.select().from(schema.onboarding).where(eq(schema.onboarding.id, ROW_ID)).get();
  if (row === undefined) throw new Error('the onboarding record has not been created');
  return {
    lastCompleted:
      row.lastCompletedStep === null ? null : OnboardingStepSchema.parse(row.lastCompletedStep),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function view(row: Row): Onboarding {
  const next = nextOnboardingStep(row.lastCompleted);
  return {
    steps: [...ONBOARDING_STEPS],
    lastCompleted: row.lastCompleted,
    next,
    finished: next === null,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function repositoryCount(db: FactoryDb | Tx): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.repositories)
      .get()?.n ?? 0
  );
}

function record(tx: Tx, actor: string, before: OnboardingStep | null, after: Row): void {
  const auditId = newId('aud');
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: after.updatedAt,
      actor,
      action: 'onboarding.step_completed',
      target: TARGET,
      jobId: null,
      beforeJson: JSON.stringify({ lastCompleted: before }),
      afterJson: JSON.stringify({ lastCompleted: after.lastCompleted }),
      policyRef: null,
      correlationId: null,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'onboarding',
    entityId: ROW_ID,
    type: 'onboarding.step_completed',
    actor,
    payload: { auditId, step: after.lastCompleted, version: after.version },
  });
}
