/**
 * How a Harness Run is billed and what it cost (ARCHITECTURE §13). Billing is
 * a subscription (the operator's own login: no per-Harness-Run cost) or an API key
 * (charged per token: the cost is an estimate, never an invoice).
 */
import { z } from 'zod';

export const BillingSchema = z.enum(['subscription', 'api_key']);
export type Billing = z.infer<typeof BillingSchema>;

/**
 * How far a cost can be trusted. `unknown/subscription`: the Harness Run was
 * billed to a subscription, so it has no per-Harness-Run cost (ARCHITECTURE §13).
 */
export const CostTagSchema = z.enum(['actual', 'estimated', 'unknown/subscription', 'unknown']);
export type CostTag = z.infer<typeof CostTagSchema>;

/**
 * Who can read the API key under `api_key` billing, as every UI must say it
 * (doctor, `job show`, the dashboard): it is in each Harness Run's
 * environment, and Tier 0 doesn't stop a command reading it.
 */
export const API_KEY_EXPOSURE =
  'visible to the Harness and every command it runs (Tier 0 guardrail, not isolation)';

/** The note on a usage whose Harness Run was given the API key (`Usage.billing: api_key`). */
export const API_KEY_BILLING_NOTE = `billed to an API key, ${API_KEY_EXPOSURE}`;

/** Why a runtime configured for `api_key` billing can't start. */
export const API_KEY_MISSING =
  "billing 'api_key' needs ANTHROPIC_API_KEY in the runtime's environment";

/** One model's prices, in USD per million tokens. */
export const ModelPriceSchema = z
  .object({
    inputUsdPerMTok: z.number().nonnegative(),
    outputUsdPerMTok: z.number().nonnegative(),
    cacheReadUsdPerMTok: z.number().nonnegative(),
    cacheWriteUsdPerMTok: z.number().nonnegative(),
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** Prices by model id (as the Harness reports it, e.g. `claude-opus-5-5`). */
export const PriceTableSchema = z.record(z.string().min(1), ModelPriceSchema);
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** One model's token counts in a Harness Run, and the Harness's own list-price cost, if any. */
export interface ModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  listCostUsd: number | null;
}

/**
 * What a Harness Run cost, and how far that can be trusted. `billedTo` is
 * what the Harness Run was actually billed to, as the Harness reported it
 * (not what was configured); `undefined` when it didn't say.
 *
 * - Subscription: `unknown/subscription`, whatever the Harness estimates.
 * - API key: `estimated`, the sum over models of the configured price (when
 *   `prices` lists the model) or else the Harness's list-price cost. A model
 *   with neither, or no per-model usage at all, makes the cost `unknown`.
 *
 * Pure.
 */
export function harnessRunCost(input: {
  billedTo: Billing | undefined;
  models: readonly ModelTokens[];
  prices?: PriceTable | undefined;
}): { costUsd: number | null; costTag: CostTag } {
  if (input.billedTo === 'subscription') return { costUsd: null, costTag: 'unknown/subscription' };
  if (input.billedTo === undefined || input.models.length === 0) {
    return { costUsd: null, costTag: 'unknown' };
  }
  let total = 0;
  for (const m of input.models) {
    const cost = modelCost(m, input.prices?.[m.model]);
    if (cost === null) return { costUsd: null, costTag: 'unknown' };
    total += cost;
  }
  return { costUsd: total, costTag: 'estimated' };
}

function modelCost(m: ModelTokens, price: ModelPrice | undefined): number | null {
  if (price === undefined) return m.listCostUsd;
  return (
    (m.inputTokens * price.inputUsdPerMTok +
      m.outputTokens * price.outputUsdPerMTok +
      m.cacheReadTokens * price.cacheReadUsdPerMTok +
      m.cacheWriteTokens * price.cacheWriteUsdPerMTok) /
    1_000_000
  );
}
