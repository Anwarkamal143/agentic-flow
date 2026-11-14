CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`job_id` text,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`policy_ref` text,
	`correlation_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_job` ON `audit_log` (`job_id`);--> statement-breakpoint
CREATE INDEX `audit_log_target` ON `audit_log` (`target`);