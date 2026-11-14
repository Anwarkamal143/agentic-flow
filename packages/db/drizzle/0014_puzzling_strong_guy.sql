DROP INDEX `acceptance_criteria_job_code`;--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_criteria_artifact_code` ON `acceptance_criteria` (`artifact_id`,`code`);--> statement-breakpoint
CREATE INDEX `acceptance_criteria_job` ON `acceptance_criteria` (`job_id`);