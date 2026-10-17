CREATE TABLE `oauth_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_secret_hash` text,
	`client_name` text,
	`redirect_uris_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`previous_refresh_token_hash` text,
	`refresh_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_access_token_hash_unique` ON `oauth_grants` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_token_hash_unique` ON `oauth_grants` (`refresh_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_previous_refresh_token_hash_unique` ON `oauth_grants` (`previous_refresh_token_hash`);