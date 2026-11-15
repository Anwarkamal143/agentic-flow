ALTER TABLE `reviews` ADD `reanchored_from_review_id` text REFERENCES reviews(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `base_merge_requested` integer DEFAULT false NOT NULL;