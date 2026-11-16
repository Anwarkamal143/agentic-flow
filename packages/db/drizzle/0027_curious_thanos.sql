CREATE TABLE `setup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`timed_out` integer NOT NULL,
	`passed` integer NOT NULL,
	`failure` text,
	`dependency_hash` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`disk_bytes` integer,
	`output_artifact_id` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`output_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `setup_runs_attempt` ON `setup_runs` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `setup_runs_worktree` ON `setup_runs` (`worktree_id`);