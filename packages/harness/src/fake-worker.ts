/**
 * The Fake Harness's developer process. The Fake starts it under the Tier 0
 * guardrail like any Harness process: it sees only the environment the factory
 * gave it, its stdin is closed, and its working directory is the Worktree.
 *
 *   node fake-worker.js '<FakeTaskResponse as JSON>'
 *
 * It performs the scripted steps in order, writes the Task Result file if the
 * script gives one, waits `delayMs`, and exits with `exitCode`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { RESULT_FILE } from '@factory/domain';
import type { FakeTaskResponse } from './fake.js';

const response = JSON.parse(process.argv[2] ?? '{}') as FakeTaskResponse;
const cwd = process.cwd();

function inside(path: string): string {
  const rel = normalize(path);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`path ${path} leaves the Worktree`);
  return join(cwd, rel);
}

const git = (args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fake Harness', '-c', 'user.email=fake@factory.invalid', ...args],
    { cwd, stdio: ['ignore', 'inherit', 'inherit'] },
  );

for (const step of response.steps) {
  if ('write' in step) {
    const abs = inside(step.write.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, step.write.content);
    process.stdout.write(`wrote ${step.write.path}\n`);
  } else if ('delete' in step) {
    rmSync(inside(step.delete), { recursive: true, force: true });
    process.stdout.write(`deleted ${step.delete}\n`);
  } else if ('commit' in step) {
    git(['add', '--all']);
    git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--message', step.commit]);
    process.stdout.write(`committed: ${step.commit}\n`);
  } else {
    execFileSync('sh', ['-c', step.run], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  }
}

const result =
  response.resultRaw ??
  (response.result === undefined ? undefined : JSON.stringify(response.result));
if (result !== undefined) {
  const abs = join(cwd, RESULT_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, result);
}

setTimeout(() => {
  process.exit(response.exitCode);
}, response.delayMs);
