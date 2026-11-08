CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`position` integer NOT NULL,
	`severity` text NOT NULL,
	`fault_origin` text NOT NULL,
	`location` text NOT NULL,
	`problem` text NOT NULL,
	`why` text NOT NULL,
	`recommendation` text NOT NULL,
	`blocking` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_findings_review_position` ON `review_findings` (`review_id`,`position`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`reviewer_harness_id` text NOT NULL,
	`reviewer_harness_version` text,
	`session_ref` text,
	`prompt_template_id` text NOT NULL,
	`prompt_template_hash` text NOT NULL,
	`packet_json` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`outcome` text NOT NULL,
	`summary` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reviews_job` ON `reviews` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_attempt_shas` ON `reviews` (`attempt_id`,`head_sha`,`base_sha`);--> statement-breakpoint
ALTER TABLE `evidence` ADD `review_id` text REFERENCES reviews(id);