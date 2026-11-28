# The Factory Level: storage, the one-time copy and `factory config`

**Status:** accepted (Phase D, #96; implements the Factory Level part of ADR-0049). The choices below are routine and reversible.

## Context

ADR-0049 puts factory-wide configuration in the database as the Factory Level and makes `config.json` bootstrap-only. The one factory-wide key `config.json` held was `concurrency.global` (ADR-0020), read once at start-up and passed to the Task scheduler. #96 asks for a versioned Factory Level row, `factory config show | set` through the runtime API with each change audited, a one-time copy of `concurrency.global` audited as `system:migration`, a `factory doctor` warning about the stale key, and the scheduler reading the value from the Factory Level.

## Decision

- **One row.** Table `factory_level` (migration 0030): `id` (always `factory`), `config_json`, `version`, `updated_at`. Its schema is `FactoryLevelConfigSchema` in `@factory/domain`, strict, every key optional (unset means the default). Today it has one key, `concurrency.global` (1–64, default 3).
- **Created on the first start; that is the copy marker.** Before the API listens, the runtime creates the row if it is missing, with `config.json`'s `concurrency.global` copied in when the file sets it (`bootstrapFactoryLevel`), at version 1. A copy writes one `audit_log` row (`system:migration`, `factory_config.migrated`, target `factory`) and one `factory.config_updated` event in the same transaction; a start with nothing to copy writes neither. Once the row exists nothing is copied again, so a later edit to the file has no effect. No separate "migrated" flag is kept.
- **`config.json` still accepts the key**, so an older file stays valid, but nothing reads it except the doctor check. `globalConcurrency` is gone from `@factory/home`.
- **API and CLI.** `GET /v1/factory/config` returns `{config, version, updatedAt}`. `POST /v1/factory/config/set {key, value, expectedVersion?}` sets one dotted leaf key through the same rule as `project config set` (`setConfigKey`, now shared), validated by the schema (`unknown_config_key`, `invalid_config_value`, 400); with `expectedVersion` a stale version is `409 version_conflict`. Each change adds one to the version and writes, in one transaction, an audit row (`user:local`, `factory_config.set`, before and after) and a `factory.config_updated` event (`entityKind: factory`, with the key, the version, before and after, and the audit id). `GET /v1/factory/config/audit` lists the Factory Level's audit rows, oldest first. `factory config show [--json]` prints each settable key with its value and source (`factory` or `default`); `factory config set <key> <value> [--expect-version <n>]` reads the value as JSON when it parses, as `project config set` does.
- **The scheduler reads at each claim.** The Task scheduler takes a function, not a number, and reads the Factory Level's `concurrency.global` before each claim, so a `config set` applies from the next claim without a restart. `claimNextTask` still takes the limit as a number.
- **Doctor.** `GET /v1/doctor` gains `staleConfigKeys: [{key, message}]`, from re-reading `config.json` at each call (`staleBootstrapKeys`), so an edit after the start is seen. `factory doctor` prints each as a warning naming the Factory Level's current value and the `factory config set` command. It is a finding, not a failure: the exit code stays 0. An unreadable file reports nothing here; the next start refuses it.

## Consequences

- The Factory Level holds only `concurrency.global` until later tickets add keys (`concurrency.perProjectJobs`, the fairness constants, ADR-0050). Narrowing against parent levels comes with the configuration hierarchy (#97).
- No dashboard view yet; the effective-config page and the wizard are later slices.
