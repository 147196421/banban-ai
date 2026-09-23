CREATE TABLE `test_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`upstream_task_id` text,
	`payload_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
