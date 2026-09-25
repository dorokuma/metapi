CREATE TABLE `upstream_provider_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proxy_log_id` integer,
	`site_id` integer,
	`account_id` integer,
	`route_id` integer,
	`channel_id` integer,
	`downstream_api_key_id` integer,
	`requested_model` text,
	`actual_model` text,
	`upstream_path` text,
	`is_stream` integer,
	`parser_id` text DEFAULT 'cline-gateway' NOT NULL,
	`parser_version` integer DEFAULT 1 NOT NULL,
	`final_provider` text,
	`resolved_provider` text,
	`canonical_slug` text,
	`original_model_id` text,
	`affinity_outcome` text,
	`affinity_pinned_provider` text,
	`client_session_id` text,
	`client_session_id_source` text,
	`fallbacks_json` text,
	`fallback_count` integer,
	`model_attempts_json` text,
	`attempts_truncated` integer DEFAULT 0 NOT NULL,
	`model_attempt_count` integer,
	`total_provider_attempt_count` integer,
	`cache_hit_tokens` integer,
	`cache_miss_tokens` integer,
	`system_fingerprint` text,
	`usage_cost` real,
	`usage_gateway_cost` real,
	`usage_market_cost` real,
	`gateway_cost_text` text,
	`gateway_inference_cost_text` text,
	`gateway_generation_id` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `upstream_provider_obs_created_idx` ON `upstream_provider_observations` (`created_at`);--> statement-breakpoint
CREATE INDEX `upstream_provider_obs_site_provider_created_idx` ON `upstream_provider_observations` (`site_id`,`final_provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `upstream_provider_obs_model_provider_created_idx` ON `upstream_provider_observations` (`requested_model`,`final_provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `upstream_provider_obs_session_created_idx` ON `upstream_provider_observations` (`client_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `upstream_provider_obs_proxy_log_idx` ON `upstream_provider_observations` (`proxy_log_id`);
