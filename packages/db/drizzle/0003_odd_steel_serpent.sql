CREATE TABLE `acceptance_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`code` text NOT NULL,
	`text` text NOT NULL,
	`mandatory` integer NOT NULL,
	`verification` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_criteria_job_code` ON `acceptance_criteria` (`job_id`,`code`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage_run_id` text,
	`kind` text NOT NULL,
	`content_hash` text NOT NULL,
	`path` text NOT NULL,
	`schema_version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_run_id`) REFERENCES `stage_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_job` ON `artifacts` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_stage_run` ON `artifacts` (`stage_run_id`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`plan_artifact_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`definition_json` text NOT NULL,
	`state` text NOT NULL,
	`priority` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_job_key` ON `tasks` (`job_id`,`key`);--> statement-breakpoint
CREATE INDEX `tasks_state` ON `tasks` (`state`);--> statement-breakpoint
ALTER TABLE `stage_runs` ADD `failure_json` text;