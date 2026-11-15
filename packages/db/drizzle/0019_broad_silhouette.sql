ALTER TABLE `repositories` ADD `merge_policy` text DEFAULT 'never_auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `merge_method` text DEFAULT 'merge' NOT NULL;