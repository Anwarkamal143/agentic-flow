import { execFileSync } from 'node:child_process';
import { repoRoot } from './paths.js';

/** Scenario tests run the built runtime and CLI, so build them first. */
export default function setup(): void {
  execFileSync('pnpm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}
