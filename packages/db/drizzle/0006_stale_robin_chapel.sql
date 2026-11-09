ALTER TABLE `attempts` ADD `cause` text DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `gate_findings_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `blocker_json` text;