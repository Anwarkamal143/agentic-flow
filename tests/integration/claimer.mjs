/**
 * One racing dispatcher for the claim-race tier (#40, ADR-0025). A real child
 * process with its own connection to the shared SQLite file (WAL mode, opened
 * with the runtime's `openDatabase`), calling the runtime's exported
 * `claimNextTask` (the built `apps/runtime/dist/claim.js`). Test-only: in
 * production only the runtime's Task scheduler writes the database.
 *
 * Usage: `node claimer.mjs <db-path> <holder>`, then over IPC:
 *   parent → `{ round, globalLimit }`: claim until nothing more can be claimed
 *   child  → `{ round, claims }` (or `{ round, error }`)
 * The child sends `{ ready: true }` once its database is open.
 */
import { openDatabase } from '@factory/db';
import { claimNextTask } from '../../apps/runtime/dist/claim.js';

const [dbPath, holder] = process.argv.slice(2);
if (dbPath === undefined || holder === undefined) {
  throw new Error('usage: claimer.mjs <db-path> <holder>');
}
if (process.send === undefined) throw new Error('claimer.mjs runs with an IPC channel (fork)');
const send = process.send.bind(process);

const handle = openDatabase(dbPath);

process.on('message', (msg) => {
  if (msg === 'exit') {
    handle.close();
    process.exit(0);
  }
  const { round, globalLimit } = msg;
  try {
    const claims = [];
    for (;;) {
      const claim = claimNextTask(handle.db, { holder, globalLimit, actor: holder });
      if (claim === undefined) break;
      claims.push(claim);
    }
    send({ round, claims });
  } catch (err) {
    send({ round, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});

send({ ready: true });
