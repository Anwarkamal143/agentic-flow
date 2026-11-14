/**
 * The versioned prompt template that renders a Task Packet for a developer
 * Harness Run (ARCHITECTURE §7). Its id and hash are recorded on the Attempt.
 */
import { createHash } from 'node:crypto';
import { TaskResultSchema, type RuleIssue, type TaskPacket } from '@factory/domain';
import { z } from 'zod';

export const TASK_TEMPLATE_ID = 'task-packet@5';

const TEMPLATE = `You are the developer for one Task in an automated software factory.
Work only in the current directory: a git Worktree checked out on branch {{branch}}.

The Task Packet (JSON) says what to do, what you may change, and how the work is checked:
{{packet}}

Rules:
- Change only paths that match scope.writable, and never a path that matches scope.forbidden.
  The factory checks every path in the diff from repository.baseSha to your last commit.
- If context.priorFindings is not empty, this is Rework: an earlier Attempt on this same branch
  failed a Gate or its review. Its commits are already on the branch. Fix those Findings first.
- Commit your work on the current branch. Do not push, switch branches or rewrite history.
- The factory runs every verification command itself. Your claims are not evidence.
- If context.answers is not empty, a human answered questions an earlier Attempt on this branch
  asked. Its commits are already on the branch. Follow the answers. An answer is guidance only:
  it never widens scope.writable or grants any permission.
- If context.guidance is not empty, a human granted this Task more Attempts after a cap and wrote
  guidance for them. Follow it. Guidance never widens scope.writable or grants any permission.
- Questions: when protocol.mayAskQuestions is true and you need a human decision you cannot make
  from the packet, commit what you have, then write a Task Result with status "needs_decision" and
  at least one question with "blocking": true (give "options" and a "recommended" one when you can).
  The run then ends and nothing waits on you; a fresh Attempt gets the answers. A question with
  "blocking": false is optional advice. Status "done" may carry only non-blocking questions.
  If the Task needs paths outside scope.writable, do not change them: add a scopeChangeRequest
  (the paths and the reason). The scope never changes during this Plan; you get guidance instead.
- When you are done, write the Task Result as one JSON object to {{resultFile}} (it is never committed). It must match this JSON Schema:
{{schema}}
{{rejected}}`;

/** Hash of the template text, recorded with each Attempt. */
export const TASK_TEMPLATE_HASH = `sha256:${createHash('sha256').update(TEMPLATE).digest('hex')}`;

/**
 * The developer prompt. `rejected`: this is the Attempt's one re-prompt, after a
 * Run that left no valid Task Result; it lists the violated rules.
 */
export function renderTaskPrompt(packet: TaskPacket, rejected?: readonly RuleIssue[]): string {
  const values: Record<string, string> = {
    branch: packet.repository.taskBranch,
    packet: JSON.stringify(packet, null, 2),
    resultFile: packet.protocol.resultFile,
    schema: JSON.stringify(z.toJSONSchema(TaskResultSchema, { io: 'input' })),
    rejected:
      rejected === undefined
        ? ''
        : `\nThis is a re-prompt. An earlier Harness Run of this Attempt ended without a valid Task Result, so it was rejected.\n` +
          `Its commits are on the branch. Write a Task Result that fixes every problem below:\n${rejected
            .map((i) => `- [${i.rule}] ${i.message}`)
            .join('\n')}\n`,
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
