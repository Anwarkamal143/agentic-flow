CREATE TABLE `github_state` (
	`id` text PRIMARY KEY NOT NULL,
	`paused_until` text,
	`paused_at` text,
	`pause_status` integer,
	`updated_at` text NOT NULL
);
