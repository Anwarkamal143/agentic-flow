ALTER TABLE `attempts` ADD `process_json` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `developer_exit_json` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `max_retries` integer DEFAULT 2 NOT NULL;