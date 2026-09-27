ALTER TABLE `proxy_logs` ADD COLUMN `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `prompt_tokens_include_cache` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `usage_source` text;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `site_id` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `model_site_id` integer;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD COLUMN `credential_site_id` integer;--> statement-breakpoint
CREATE INDEX `proxy_logs_site_id_idx` ON `proxy_logs` (`site_id`, `id`);
