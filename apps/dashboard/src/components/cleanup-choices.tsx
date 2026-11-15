'use client';

/**
 * The cleanup Approval's choices (ADR-0043): per question its fixed options,
 * the default (keep) checked and sent as unanswered. While the PR is kept,
 * deleting its remote branch is disabled: GitHub would close the PR, so the
 * runtime refuses that pair (and says so on its refusal page when scripts
 * are off). Switching the PR back to keep resets the branch to keep.
 */
import type { InboxQuestion } from '@factory/domain';
import { useState } from 'react';

const KEEP = 'keep';

export function CleanupChoices({ questions }: { questions: readonly InboxQuestion[] }) {
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.recommended ?? KEEP])),
  );
  const prAsked = questions.some((q) => q.id === 'pull_request');
  const prKept = prAsked && chosen['pull_request'] === KEEP;
  const choose = (id: string, option: string) => {
    setChosen((now) => {
      const next = { ...now, [id]: option };
      if (id === 'pull_request' && option === KEEP && next['remote_branch'] === 'delete') {
        next['remote_branch'] = KEEP;
      }
      return next;
    });
  };
  return (
    <>
      {questions.map((q) => (
        <fieldset key={q.id} className="space-y-1 text-sm">
          <legend className="font-medium">{q.text}</legend>
          {q.options.map((o) => {
            const blocked = q.id === 'remote_branch' && o === 'delete' && prKept;
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
          {q.id === 'remote_branch' && prKept && (
            <p className="text-xs text-muted-foreground" data-testid="delete-needs-close">
              Deleting the remote branch closes the PR on GitHub, so it needs “close” on the PR too.
            </p>
          )}
        </fieldset>
      ))}
    </>
  );
}
