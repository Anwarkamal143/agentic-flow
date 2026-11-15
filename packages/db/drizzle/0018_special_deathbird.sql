CREATE TABLE `pr_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`outcome` text NOT NULL,
	`url` text,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_checks_identity` ON `pr_checks` (`pull_request_id`,`head_sha`,`source`,`name`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `mergeable_state` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `head_seen_at` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `changes_requested_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `gate_json` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `gate_evaluated_at` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `body_sha256` text;