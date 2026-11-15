# The `human_approval` Merge Policy and the factory's merge

**Status:** accepted (#59, Phase C, C3). These are routine, reversible choices inside the Phase C design (#52): Q5, Q7, Q15, Q21 in PROGRESS.md, and ARCHITECTURE §8.1's `merge_method_refused`.

## The Merge Policy and the merge method are stored on the Repository

- Two columns on `repositories` (migration 0019): `merge_policy` (`never_auto | human_approval`, default `never_auto`) and `merge_method` (`merge | squash | rebase`, default `merge`). They are set at `factory repo add --merge-policy … --merge-method …`. There is no command to change them after registration, as with the GitHub coordinates. They are columns, not part of the profile, because they are policy, not detected commands.
- `MergePolicySchema` has `never_auto` and `human_approval` only, so `auto_if_low_risk_and_green` is refused by the API schema and by the CLI ("not available until Phase E").
- **A Job override** (`POST /v1/jobs` `mergePolicy`, `factory job create --merge-policy`) may only make the policy stricter. `resolveMergePolicy` (pure) orders the policies strictest first: `never_auto`, then `human_approval`. A looser override is refused with 409 `merge_policy_looser`.
- The resolved policy is frozen into the Job's Effective Configuration as `mergePolicy: {value, source: repository | job}`, like the other settings. Jobs created before #59 parse as `never_auto` (source `repository`), the only policy they could have had. The gate, the `merge` item and the Delivery Report read the Job's frozen policy, never the Repository's current one.

## The merge commit is the default method

`merge.method` defaults to `merge`, a merge commit (Q21). It keeps the reviewed head SHA itself in the default branch's history: the commit the Integration Review approved and the checks ran on is a parent of the merge, so the Gates' `(head_sha, base_sha)` stays traceable after the merge. A squash or rebase merge writes new commits the factory never verified. A Repository may still choose `squash` or `rebase`. The fake GitHub doesn't implement `rebase` (it answers 501).

## The `merge` item under `human_approval`

- It is still one item per PR `(head_sha, base_sha)` held by `merge_approval` (ADR-0037). The question is "Approve merging pull request …".
- **Options** come from `mergeItemOptions(policy, gate)` (pure): `merge` and `cancel_job` while every condition but the policy passes, and only `cancel_job` otherwise, or before the first poll. `request_changes` is #60's, as under `never_auto`.
- The poller keeps the options in step with the gate: when the stored gate changes on the same SHAs, a differing option set is written with `approval.options_changed` and a version bump. So a decision made on the old options is refused (`version_conflict`, or `unknown_option` for `merge`). A new head or base supersedes the item as before, and the new item is opened with the options of the gate just stored.
- **The gate's `policy` condition:** under `human_approval` it is pending ("the factory merges once a human approves the merge item in the Inbox"). Once approved it passes, naming who approved and when (`withMergeApproval`). So the verdict is `pass` only after the approval.

## Approving the merge

`merge` is decided in one versioned Job transaction (`approveMerge`):

1. The item is marked decided (`user:local`), the same as every decision.
2. Inside the same transaction the stored gate must be on the item's SHAs with every other condition passing, or the decision is refused (409 `merge_gate_not_passing`). The options already enforce this; the check guards a race with the poller.
3. **The audit entry:** `audit_log` gets action `merge.approved`, target `pull_request:<id>`, the actor and time. `after` holds the PR, its URL, `headSha`, `baseSha` and the method, `policyRef` is `inbox:<item>/merge`, and an `audit.recorded` event goes with it.
4. The gate is stored with the policy passed, with a `merge_gate.approved` event; `gate_evaluated_at` keeps the poller's time.
5. Once every PR of the Job is approved (or merged), `merge_approval` succeeds and `merge` is queued. The poller stops polling, because it only polls PRs whose `merge_approval` is `waiting_human`.

## The merger

`Merger` (`apps/runtime/src/merger.ts`) runs on its own `PassLoop`. It is woken by every commit, with a timer at `github.pollIntervalMs` for retries. Each pass takes every `merge` Stage Run that is `queued`, or `running` (a crash or a transient failure left it so). For each PR still open in the rows:

- **Re-read first**, without an ETag, never trusting the rows. The approved SHAs come from the decided item's subject, not from the row.
- **Already merged** (a human merged it meanwhile, or a merge whose answer a crash lost): it is recorded as merged with GitHub's merge commit (`pull_request.merged`, `how: already_merged`), and no merge request is sent. A PR is never merged twice.
- **Closed, or its head or base no longer the approved SHAs:** the approval is stale, because Gates are tied to SHAs. Nothing is merged and `merge` fails with `delivery_failed`. A route back to a fresh approval belongs to C2 and the PR feedback loop (known limitation).
- **Otherwise:** `PUT /pulls/:n/merge` with the Repository's method, pinned to the approved head (`sha`), so GitHub refuses if the head moved in between.
  - Success: recorded `how: merged`.
  - A 405 whose message says the method is not allowed raises the `merge_method_refused` human Blocker on `merge`. The Stage goes `waiting_human`, not failed, and its Blocker Approval holds the `merge` Stage Run and offers `retry_merge` (`merge` queued again, so the PR is re-read first) and `cancel_job`. GitHub gives no error code, so the method refusal is recognised by its message (`/not allowed/i`), as GitHub words it ("Merge commits are not allowed on this repository.").
  - Any other refusal (4xx) fails `merge` with `delivery_failed` and GitHub's message.
  - A transient failure or a rate limit is logged, and the Stage stays `running` until the next timer pass.

Once every PR is merged, `merge` succeeds with `mergeSha` (and `mergeShas`) on its event and closure is queued, the same as under `never_auto`. The actor is `system:merger`.

## The Delivery Report

The shape stays v6. A failed `merge` makes the outcome `failed`, and the statement says the approved merge was not made and why. The limitation and the statement name the policy: under `human_approval` "merged … after your approval", or "awaits your merge approval in the Inbox".
