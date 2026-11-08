CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`n` integer NOT NULL,
	`state` text NOT NULL,
	`harness_id` text NOT NULL,
	`harness_version` text,
	`session_ref` text,
	`prompt_template_id` text NOT NULL,
	`prompt_template_hash` text NOT NULL,
	`packet_json` text NOT NULL,
	`worktree_id` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text,
	`commits_json` text NOT NULL,
	`wip_commit` text,
	`protocol_violations_json` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`exit_reason` text,
	`exit_detail` text,
	`usage_json` text,
	`version` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_n` ON `attempts` (`task_id`,`n`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`verification_run_id` text,
	`criterion_id` text,
	`verdict` text NOT NULL,
	`detail` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`artifact_id` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_attempt` ON `evidence` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `leases` (
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`holder` text NOT NULL,
	`lease_id` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	PRIMARY KEY(`resource_kind`, `resource_id`)
);
--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`command_key` text NOT NULL,
	`command` text NOT NULL,
	`required` integer NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`exit_code` integer,
	`timed_out` integer NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`output_artifact_id` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`output_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verification_runs_attempt` ON `verification_runs` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`state` text NOT NULL,
	`port_base` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_task` ON `worktrees` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path` ON `worktrees` (`path`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `attempt_id` text;