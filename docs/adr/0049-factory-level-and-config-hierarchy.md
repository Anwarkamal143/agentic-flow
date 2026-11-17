# The Factory Level and the configuration hierarchy

**Status:** accepted (Phase D design grilling, Q3, Q4, Q18, Q25; confirmed by the human 2026-11-17).

ARCHITECTURE §15 listed "invariants > org > project > repo > recipe defaults > job overrides > task restrictions", which read literally lets recipe defaults beat Repository settings, the opposite of the code (job > project > recipe). We replace "org" with a single **Factory Level** stored in the DB (one local user, no organisation) and order the levels from least to most specific: recipe < Factory < Project < Repository < Job < Task. The most specific level that sets a value wins, Immutable Invariants are a ceiling, and a permission-related value may only narrow relative to the level above it, through `config set` and `config import` alike.

## Decision

- **`config.json` becomes bootstrap-only** (home, port, workspace root, where the API token lives). On the first start after the migration, the runtime copies an existing `concurrency.global` into the Factory Level once, audited as `system:migration`; afterwards the key is ignored and `factory doctor` warns that it is stale. The DB is authoritative at runtime (§15).
- **The snapshot covers every Repository of the Project.** A Job's Effective Configuration holds Job-wide values plus a section per Repository (merge policy, merge method, setup, profile commands, required checks, Sensitive Paths), all resolved at creation. Triage may pick the Repository set after creation, so every Repository of the Project is resolved then; the Job uses the sections of its confirmed set. "Frozen at creation" stays true.
- **Sources** are `invariant | recipe | factory | project | repository | job | task`, shown on the effective-config page with the chain of narrowings for permission values.
- **Import:** YAML keyed by name, validated, diffed, applied with `--apply --expect-version` as one transaction with one `config.imported` event and one audit row holding the diff. It may create Projects, refuses unregistered Repositories, and refuses a lower level wider than its parent.

## Consequences

- A Repository registered after a Job's creation is not available to that Job.
- Re-snapshotting a Job is deferred (spec issue 46).
