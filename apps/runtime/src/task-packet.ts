/**
 * The versioned prompt template that renders a Task Packet for a developer
 * Harness Run (ARCHITECTURE §7). Its id and hash are recorded on the Attempt.
 */
import { createHash } from 'node:crypto';
import { TaskResultSchema, type TaskPacket } from '@factory/domain';
import { z } from 'zod';

export const TASK_TEMPLATE_ID = 'task-packet@1';

const TEMPLATE = `You are the developer for one Task in an automated software factory.
Work only in the current directory: a git Worktree checked out on branch {{branch}}.

The Task Packet (JSON) says what to do, what you may change, and how the work is checked:
{{packet}}

Rules:
- Change only paths that match scope.writable, and never a path that matches scope.forbidden.
- Commit your work on the current branch. Do not push, switch branches or rewrite history.
- The factory runs every verification command itself. Your claims are not evidence.
- You cannot ask questions in this Run.
- When you are done, write the Task Result as one JSON object to {{resultFile}} (it is never committed). It must match this JSON Schema:
{{schema}}
`;

/** Hash of the template text, recorded with each Attempt. */
export const TASK_TEMPLATE_HASH = `sha256:${createHash('sha256').update(TEMPLATE).digest('hex')}`;

export function renderTaskPrompt(packet: TaskPacket): string {
  const values: Record<string, string> = {
    branch: packet.repository.taskBranch,
    packet: JSON.stringify(packet, null, 2),
    resultFile: packet.protocol.resultFile,
    schema: JSON.stringify(z.toJSONSchema(TaskResultSchema, { io: 'input' })),
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
