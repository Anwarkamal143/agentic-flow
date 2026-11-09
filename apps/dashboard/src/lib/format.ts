/**
 * How persisted values are labelled. Nothing here invents a value: a value
 * the runtime didn't record is shown as unknown, with the reason it is
 * unknown when the record says so (PRODUCT_SPEC §11).
 */
import { API_KEY_BILLING_NOTE, type Usage } from '@factory/domain';
import type { BadgeVariant } from '@/components/ui/badge';

const GOOD = new Set(['completed', 'succeeded', 'passed', 'approved', 'integrated', 'pass']);
const BAD = new Set(['failed', 'rejected', 'fail', 'changes_requested', 'interrupted']);
const WAITING = new Set(['waiting_human', 'blocked', 'gates_failed', 'not_tested']);
const BUSY = new Set(['active', 'running', 'verifying', 'in_review', 'claimed', 'queued', 'ready']);

/** The badge colour of a state, status or verdict. */
export function stateVariant(state: string): BadgeVariant {
  if (GOOD.has(state)) return 'success';
  if (BAD.has(state)) return 'destructive';
  if (WAITING.has(state)) return 'warning';
  if (BUSY.has(state)) return 'default';
  return 'secondary';
}

export function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

export function shortSha(sha: string | null): string {
  return sha === null ? 'none' : sha.slice(0, 10);
}

/** An ISO timestamp as UTC, to the second. Server and browser render the same text. */
export function formatTime(iso: string | null): string {
  return iso === null ? '—' : iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${String(s)} s` : `${String(Math.floor(s / 60))} min ${String(s % 60)} s`;
}

export interface UsageLabels {
  tokens: string;
  cost: string;
  duration: string;
}

export function usageLabels(usage: Usage | null): UsageLabels {
  if (usage === null) {
    return {
      tokens: 'unknown (not recorded)',
      cost: 'unknown (not recorded)',
      duration: 'unknown',
    };
  }
  const count = (n: number | null) => (n === null ? 'unknown' : n.toLocaleString('en-US'));
  const tokens =
    usage.inputTokens === null && usage.outputTokens === null
      ? 'unknown (not reported by the Harness)'
      : `${count(usage.inputTokens)} in / ${count(usage.outputTokens)} out (${usage.tag})`;
  const costTag = usage.costTag ?? usage.tag;
  let cost: string;
  if (costTag === 'unknown/subscription') cost = 'unknown (subscription)';
  else if (usage.costUsd === null) cost = 'unknown';
  else cost = `$${usage.costUsd.toFixed(4)} (${costTag})`;
  if (usage.billing === 'api_key') cost += `, ${API_KEY_BILLING_NOTE}`;
  return { tokens, cost, duration: formatDuration(usage.durationMs) };
}
