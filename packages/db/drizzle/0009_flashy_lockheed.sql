CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`stage_run_id` text,
	`kind` text NOT NULL,
	`subject_ref` text NOT NULL,
	`question` text NOT NULL,
	`why` text NOT NULL,
	`options_json` text NOT NULL,
	`recommended` text,
	`evidence_json` text NOT NULL,
	`state` text NOT NULL,
	`deferred` integer NOT NULL,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_json` text,
	`expires_policy` text NOT NULL,
	`created_at` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_run_id`) REFERENCES `stage_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_job` ON `approvals` (`job_id`);--> statement-breakpoint
CREATE INDEX `approvals_state` ON `approvals` (`state`);