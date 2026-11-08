CREATE TABLE `job_repositories` (
	`job_id` text NOT NULL,
	`repository_id` text NOT NULL,
	PRIMARY KEY(`job_id`, `repository_id`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`workflow_snapshot_json` text NOT NULL,
	`config_snapshot_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_project` ON `jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `stage_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text NOT NULL,
	`attempt` integer NOT NULL,
	`resume_stage_id` text,
	`blocker_json` text,
	`started_at` text,
	`finished_at` text,
	`version` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_runs_job_stage_attempt` ON `stage_runs` (`job_id`,`stage_id`,`attempt`);