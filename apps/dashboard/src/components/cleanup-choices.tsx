'use client';

/**
 * The cleanup Approval's choices (ADR-0043): per question its fixed options,
 * the default (keep) checked and sent as unanswered. While a PR is kept,
 * deleting its remote branch is disabled: GitHub would close the PR, so the
 * runtime refuses that pair (and says so on its refusal page when scripts
 * are off). Switching the PR back to keep resets the branch to keep. In a
 * multi-repo Job the questions are per Repository (`<repo>.<question>`,
 * ADR-0069), and the pair is per Repository too.
 */
import type { InboxQuestion } from '@factory/domain';
import { useState } from 'react';

const KEEP = 'keep';

/** The `<repo>.` a question key starts with (`''` when bare) and its question id. */
function split(key: string): { prefix: string; question: string } {
  const dot = key.lastIndexOf('.');
  return dot < 0
    ? { prefix: '', question: key }
    : { prefix: key.slice(0, dot + 1), question: key.slice(dot + 1) };
}

export function CleanupChoices({ questions }: { questions: readonly InboxQuestion[] }) {
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.recommended ?? KEEP])),
  );
  /** Whether the PR of the Repository `prefix` names is asked about and kept. */
  const prKept = (prefix: string) =>
    questions.some((q) => q.id === `${prefix}pull_request`) &&
    chosen[`${prefix}pull_request`] === KEEP;
  const choose = (id: string, option: string) => {
    setChosen((now) => {
      const next = { ...now, [id]: option };
      const { prefix, question } = split(id);
      const branch = `${prefix}remote_branch`;
      if (question === 'pull_request' && option === KEEP && next[branch] === 'delete') {
        next[branch] = KEEP;
      }
      return next;
    });
  };
  return (
    <>
      {questions.map((q) => {
        const { prefix, question } = split(q.id);
        const branchHeld = question === 'remote_branch' && prKept(prefix);
        return (
          <fieldset key={q.id} className="space-y-1 text-sm">
            <legend className="font-medium">{q.text}</legend>
            {q.options.map((o) => {
              const blocked = branchHeld && o === 'delete';
              return (
                <label key={o} className="mr-4 inline-flex items-center gap-1">
                  <input
                    type="radio"
                    name={`choice.${q.id}`}
                    value={o === q.recommended ? '' : o}
                    checked={chosen[q.id] === o}
                    disabled={blocked}
                    onChange={() => {
                      choose(q.id, o);
                    }}
                  />
                  {o}
                  {q.recommended === o && (
                    <span className="text-xs text-muted-foreground">(default)</span>
                  )}
                </label>
              );
            })}
            {branchHeld && (
              <p className="text-xs text-muted-foreground" data-testid="delete-needs-close">
                Deleting the remote branch closes the PR on GitHub, so it needs “close” on the PR
                too.
              </p>
            )}
          </fieldset>
        );
      })}
    </>
  );
}
