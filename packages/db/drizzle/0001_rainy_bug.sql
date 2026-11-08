CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`remote_url` text,
	`clone_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`profile_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_source` ON `repositories` (`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_project_name` ON `repositories` (`project_id`,`name`);