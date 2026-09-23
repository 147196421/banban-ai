CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limits_updated_at` ON `rate_limits` (`updated_at`);