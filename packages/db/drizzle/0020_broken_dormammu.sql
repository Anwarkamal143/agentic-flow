CREATE TABLE `pr_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`author` text,
	`review_state` text,
	`path` text,
	`url` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`observed_at` text NOT NULL,
	`attempt_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_feedback_identity` ON `pr_feedback` (`pull_request_id`,`source`,`external_id`);