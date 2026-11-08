// Fails when src/schema.ts has changes that are not captured in a migration.
// Runs drizzle-kit generate against a temporary copy of the migrations folder.
// drizzle-kit can exit 0 on errors, so success requires its explicit
// "No schema changes" message and no new files.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'factory-migrations-'));
let exitCode = 0;
try {
  const out = join(tmp, 'drizzle');
  cpSync(join(pkg, 'drizzle'), out, { recursive: true });
  const before = readdirSync(out).length;
  const config = join(tmp, 'drizzle.config.mjs');
  const options = { dialect: 'sqlite', schema: join(pkg, 'src/schema.ts'), out: './drizzle' };
  writeFileSync(config, `export default ${JSON.stringify(options)};`);
  const drizzleKit = join(pkg, 'node_modules/.bin/drizzle-kit');
  const output = execFileSync(drizzleKit, ['generate', '--config', config], {
    cwd: tmp,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (readdirSync(out).length !== before) {
    console.error('Schema changed without a migration. Run: pnpm --filter @factory/db db:generate');
    exitCode = 1;
  } else if (!output.includes('No schema changes')) {
    console.error(`Could not verify migrations; drizzle-kit said:\n${output}`);
    exitCode = 1;
  } else {
    console.log('Migrations are up to date with the schema.');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
