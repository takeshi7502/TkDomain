CREATE TABLE `subdomain_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`subdomain` text NOT NULL,
	`cname_target` text NOT NULL,
	`github_handle` text,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	`reviewer_note` text,
	`cloudflare_record_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subdomain_requests_subdomain_unique` ON `subdomain_requests` (`subdomain`);--> statement-breakpoint
CREATE INDEX `idx_subdomain_requests_status_created` ON `subdomain_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_subdomain_requests_email_created` ON `subdomain_requests` (`email`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
