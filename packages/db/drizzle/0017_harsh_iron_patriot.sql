CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`task_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`pushed_sha` text NOT NULL,
	`adopted` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_polled_at` text,
	`version` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_job_head` ON `pull_requests` (`job_id`,`repository_id`,`head_branch`);--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_number` ON `pull_requests` (`owner`,`name`,`number`);