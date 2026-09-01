CREATE TABLE `delete_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`canonical_url` text,
	`source_hash` text,
	`source_type` text NOT NULL,
	`author` text,
	`captured_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`status` text NOT NULL,
	`progress` real NOT NULL,
	`tags_json` text NOT NULL,
	`ingestion_state` text NOT NULL,
	`summary` text,
	`file_path` text NOT NULL,
	`revision` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_canonical_url_unique` ON `items` (`canonical_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_hash` ON `items` (`source_hash`) WHERE "items"."source_hash" IS NOT NULL;
