# The question protocol: Questions during execution (Phase B, issue #42)

**Status:** accepted (#42, Phase B). The design is ARCHITECTURE §7 (Question rules) and §8, and the Phase B grilling's Q15/Q16 (`PROGRESS.md`). The choices below are routine and reversible. Pure rules live in `packages/domain/src/questions.ts`; the runtime side in `apps/runtime/src/questions.ts`, `execution.ts` (`askHuman`) and `inbox.ts` (`answer`).

## Who may ask

- **The developer packet sets `protocol.mayAskQuestions: true`.** The prompt template `task-packet@4` says how: commit what you have, write `status: "needs_decision"` with at least one `blocking: true` question (options and a recommendation optional), or a `scopeChangeRequest`; `done` may carry only non-blocking questions; `context.answers` holds earlier answers, which are guidance only.
- **The reviewer can't ask.** Its packet has no protocol field and its output (`ReviewProposalSchema`) has no status or questions: a review is always a verdict.

## Which results ask, and which contradict themselves

- **A result asks** when its status is `needs_decision`, or when it carries a `scopeChangeRequest` (whatever its status; ARCHITECTURE §7 "treated as `needs_decision`").
- **Protocol violations** (rule ids `questions.blocking_required`, `questions.done_with_blocking`): `needs_decision` with neither a blocking question nor a scope change request, and `done` with a blocking question. They make the Task Result *invalid*, exactly like a schema error: the one re-prompt of ADR-0010 carries the rule; still invalid, the Attempt fails `invalid_output`.
- **No Gate runs on an asking result.** Its commits stay on the Task Branch; the answer Attempt's Gates check the whole `base..head` later. Leftovers still become a WIP commit and the head is pinned, as for any Attempt.

## Pausing: one transaction, no process

When a valid result asks (`TaskScheduler.askHuman`), one `changeJob` transaction records the Task Result Artifact and the questions on the Attempt, ends the Attempt in the new state **`needs_decision`** (exit reason `needs_decision`), opens the Inbox Item, moves the Task `verifying → blocked` with Blocker `{kind: human, reason: awaiting_human}`, **releases the Task lease and its capacity tokens** (`releaseAttemptTokens`, ADR-0020), preserves the Worktree and settles `execution` (to `waiting_human` once nothing else is in progress; independent Tasks keep running). The Harness has already exited, so nothing is alive while the Task waits, and a runtime restart has nothing to recover: the Question is just rows.

## The Inbox Question

- **One `question` item per asking Attempt.** `subject_ref` is the asking Attempt's id; it holds the `execution` Stage Run and names the Task; `requested_by` is `agent:<harness>/<attempt>`; its Evidence is the Task Result Artifact.
- **The questions are batched** in the new column `approvals.questions_json` (`InboxQuestion[]`): every question of the result in order (`q1`, `q2`, …; non-blocking ones are `blocking: false`, i.e. optional), then the scope change request as `scope` (blocking, with the paths it asked for). Each is `agentProposed: true`, and a recommendation that isn't one of its options is dropped. The same list is kept on the Attempt (`attempts.questions_json`).
- **Redaction:** the text and options are agent output. They are redacted before storage by the database binding redactor every write goes through (ADR-0011), and the Task Result Artifact is redacted on write.
- **Its one option is `answer`** (`QUESTION_OPTIONS`, not agent-proposed). The questions' own options are the agent's and are on the questions. `POST /v1/inbox/:id/decide` refuses a question item (`409 answer_required`).

## Answering

- **`answerQuestion`: `POST /v1/inbox/:id/answer`** `{expectedVersion, subjectRef, answers: [{questionId, option | text}]}`. The ADR-0016 rule applies first (human actor, open, version, subject), then `checkAnswers`: every blocking question answered, each answer exactly one offered option or non-blank free text, no unknown or repeated question (`400 answer_missing | unknown_question | invalid_answer`). Optional questions may be left out.
- **One transaction:** the item is `decided` (`decision_json` holds the answers), the Task goes `blocked → ready` (reason `answered`), and `execution` goes `waiting_human | blocked → queued` (the claim moves it to `running`). The next claim starts a fresh Attempt, **`cause: answer`**, in the preserved Worktree on the same Task Branch.
- **The packet carries the answers:** `context.answers` (`AnsweredQuestion[]`: asking Attempt `n`, question id, source, text, blocking, the answer and whether it was an option or text; `null` for an unanswered optional one). Every later Attempt of the Task carries all earlier answers (Rework and Retries included). Its `priorFindings` are the asking Attempt's packet's (it raised none).
- **An answer never grants permissions.** It is text in the packet: the scope, caps and policy come from the Task and the Effective Configuration as before. A `scopeChangeRequest` is answered with guidance; the globs never change mid-Plan.
- **CLI:** `factory inbox answer <id> (--answer [<q>=]<text>... | --file <answers.json>) [--expect-version <n>]`. A plain `--answer` goes to the next question in order, `q2=…` to that one; a value equal to one of the question's options is sent as that option, anything else as free text. Without `--expect-version` the version just read is used (Q27); the subject is always the item's. `inbox show` prints the questions and the answer command.
- **Dashboard:** the item page lists the questions (labelled "proposed by an agent", blocking or optional, scope paths "never granted") and an answer form: per question its options as radio buttons plus "My own answer" and a text box; it posts to `POST /api/inbox/[id]/answer` under ADR-0022's checks. An option and text both given are both sent, so the runtime refuses the answer instead of the dashboard silently dropping one.

## The cap

- **`max_questions` (Effective Configuration, default 3) is copied onto each Task (`tasks.max_questions`)** like `max_attempts` and `max_retries`. It caps answer Attempts: when an Attempt asks and the Task already has `max_questions` Attempts of cause `answer`, no item opens; the Task is `blocked` with a human `question_cap_reached` Blocker (questions kept on the Attempt). Until the Blocker Approvals ticket (#43) gives it options, that Blocker is a dead end except cancelling the Job.
- **Separate caps:** an answer Attempt counts toward neither `max_attempts` (`attemptsCountedForRework` skips `answer` and `retry`) nor `max_retries` (recovery counts `retry` only).

## Non-blocking questions under `done`

They open no item. They are recorded on the Attempt (`questions`) and the Delivery Report lists the approved Attempt's ones per Task (`openQuestions`) and as an "open question" known limitation. The report stays `reportVersion: 2` (the field has a default); the report v3 of #44 can absorb it.

## Not built here

- **"Replan with this request as feedback"** for a scope change request (ARCHITECTURE §8 step 6): an execution-time Replan doesn't exist before the Requested Replan ticket (#45), so the item offers only the answer. #45 adds the option (counting against `max_replans`).
- **`resume(sessionRef, …)`** stays an unused extension point of the Harness contract: every answer Attempt is a new Session.
- **Cancelling a Task's Question when a Replan or the `plan` route cancels the Task** (#45, #46): cancelling the Job already cancels it (`cancelOpenItems`).
