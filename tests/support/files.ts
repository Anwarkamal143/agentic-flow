import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
