CREATE VIRTUAL TABLE `item_search` USING fts5(
	`id` UNINDEXED,
	`title`,
	`source`,
	`insights`,
	`tags`,
	tokenize='porter unicode61'
);
