ALTER TABLE `approvals` ADD `questions_json` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `questions_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `max_questions` integer DEFAULT 3 NOT NULL;