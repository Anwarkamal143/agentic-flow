DROP INDEX `tasks_job_key`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_plan_key` ON `tasks` (`plan_artifact_id`,`key`);--> statement-breakpoint
CREATE INDEX `tasks_job` ON `tasks` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `replans_used` integer DEFAULT 0 NOT NULL;