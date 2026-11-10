ALTER TABLE `jobs` ADD `replan_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cancel_reason` text;