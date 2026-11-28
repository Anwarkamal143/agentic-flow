CREATE TABLE `onboarding` (
	`id` text PRIMARY KEY NOT NULL,
	`last_completed_step` text,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL
);
