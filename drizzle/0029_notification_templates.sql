CREATE TABLE `notification_templates` (
	`event_type` text NOT NULL,
	`channel` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`parse_mode` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	PRIMARY KEY (`event_type`,`channel`)
);
