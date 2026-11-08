CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`job_id` text,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`payload_json` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE INDEX `events_job_seq` ON `events` (`job_id`,`seq`);