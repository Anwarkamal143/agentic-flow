# Fair scheduling across Projects

**Status:** accepted (Phase D design grilling, Q10, Q23, Q24; confirmed by the human 2026-11-17). Routine and reversible: the constants live at the Factory Level.

Both the Task scheduler and the proposal-Stage scheduler order their candidates by `effective_priority = TASK_PRIORITY_WEIGHT + 0.5 × floor(wait_seconds / 60) − (project's Jobs in flight ÷ project's perProjectJobs)`. The penalty is 0 when the Project's limit is unlimited. Sharing the function matters because a Job spends its first minutes in proposal Stages; fairness only in execution would leave D2 untested.

- **`concurrency.perProjectJobs`** (camelCase like the other `concurrency.*` keys; ROADMAP's `per_project_jobs`) is a capacity value set at the Factory Level (default unlimited) and overridable per Project, upward or downward. It counts Jobs with work in flight, a running Attempt or proposal Stage Run, never Jobs waiting on a human, so a plan waiting days for approval doesn't hold the slot. It is enforced at claim time with the other capacity tokens.
- **Aging is meant to overtake.** With weights −1/0/+1, a `low` Task overtakes a `normal` one after 2 minutes of waiting.
- **D2's bound:** five Jobs in three Projects, `perProjectJobs: 1`, FakeHarness at fixed durations. Each Project has a Job in flight before any Project starts its second Job, and the longest mean ready-wait of any Project is at most 2× the shortest.
