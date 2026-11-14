DROP INDEX `tasks_plan_key`;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kind` text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_plan_integration` ON `tasks` (`plan_artifact_id`,`repository_id`) WHERE "kind" = 'integration';--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_plan_key` ON `tasks` (`plan_artifact_id`,`key`) WHERE "kind" = 'plan';