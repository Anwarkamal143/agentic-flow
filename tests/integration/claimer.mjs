/**
 * One racing dispatcher for the claim-race tier (#40, #99, ADR-0025). A real
 * child process with its own connection to the shared SQLite file (WAL mode,
 * opened with the runtime's `openDatabase`), calling the runtime's exported
 * `claimNextTask` and `claimNextProposalStage` (the built
 * `apps/runtime/dist/claim.js`). Test-only: in production only the runtime's
 * schedulers write the database.
 *
 * Usage: `node claimer.mjs <db-path> <holder>`, then over IPC:
 *   parent → `{ round, globalLimit, proposals? }`: claim until nothing more can
 *            be claimed (with `proposals`, queued proposal Stage Runs too,
 *            alternating with Tasks)
 *   child  → `{ round, claims, proposalClaims }` (or `{ round, error }`)
 * The child sends `{ ready: true }` once its database is open.
 */
import { openDatabase } from '@factory/db';
import { claimNextProposalStage, claimNextTask } from '../../apps/runtime/dist/claim.js';

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
  const { round, globalLimit, proposals } = msg;
  try {
    const claims = [];
    const proposalClaims = [];
    for (;;) {
      const claim = claimNextTask(handle.db, { holder, globalLimit, actor: holder });
      if (claim !== undefined) claims.push(claim);
      const proposal =
        proposals === true
          ? claimNextProposalStage(handle.db, { holder, actor: holder })
          : undefined;
      if (proposal !== undefined) proposalClaims.push(proposal);
      if (claim === undefined && proposal === undefined) break;
    }
    send({ round, claims, proposalClaims });
  } catch (err) {
    send({ round, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});

send({ ready: true });
