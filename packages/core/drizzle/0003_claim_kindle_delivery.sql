CREATE TABLE `kindle_delivery_claims` (
	`item_id` text NOT NULL,
	`target_serial` text NOT NULL,
	`claim_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `target_serial`)
);
