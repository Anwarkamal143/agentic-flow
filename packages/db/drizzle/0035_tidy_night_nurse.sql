CREATE TABLE `issue_intakes` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`approval_id` text,
	`job_id` text,
	`created_at` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_intakes_issue` ON `issue_intakes` (`repository_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_intakes_job` ON `issue_intakes` (`job_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`task_id` text,
	`stage_run_id` text,
	`kind` text NOT NULL,
	`subject_ref` text NOT NULL,
	`question` text NOT NULL,
	`why` text NOT NULL,
	`questions_json` text,
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
INSERT INTO `__new_approvals`("id", "job_id", "task_id", "stage_run_id", "kind", "subject_ref", "question", "why", "questions_json", "options_json", "recommended", "evidence_json", "state", "deferred", "requested_by", "decided_by", "decided_at", "decision_json", "expires_policy", "created_at", "version") SELECT "id", "job_id", "task_id", "stage_run_id", "kind", "subject_ref", "question", "why", "questions_json", "options_json", "recommended", "evidence_json", "state", "deferred", "requested_by", "decided_by", "decided_at", "decision_json", "expires_policy", "created_at", "version" FROM `approvals`;--> statement-breakpoint
DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `__new_approvals` RENAME TO `approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approvals_job` ON `approvals` (`job_id`);--> statement-breakpoint
CREATE INDEX `approvals_state` ON `approvals` (`state`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `source_issue_json` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `intake_label` text;