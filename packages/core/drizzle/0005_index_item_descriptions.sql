-- Replace the agent-written insights column with the item description.
-- Startup reconciliation re-indexes every item from Markdown.
DROP TABLE `item_search`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `item_search` USING fts5(
	`id` UNINDEXED,
	`title`,
	`source`,
	`summary`,
	`tags`,
	tokenize='porter unicode61'
);
