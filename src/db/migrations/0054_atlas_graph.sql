-- Atlas §0 — the materialized per-user knowledge graph. Derived from facets,
-- triage_events, product_key, and the catalogue; rebuilt deterministically when
-- those change. Nodes = projects/products/capabilities/candidates/modalities;
-- edges = HAS_CAPABILITY / ADJACENT_TO / FILLS / EVALUATED / MEMBER_OF /
-- RELATES_TO / ENDORSED_BY_SIMILAR. This is the layer Leaps (§1), recall (§2),
-- the Atlas export (§4), and themes (§5) all traverse.
CREATE TABLE `graph_nodes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `kind` text NOT NULL,
  `node_key` text NOT NULL,
  `label` text NOT NULL,
  `data` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_node` ON `graph_nodes` (`user_id`,`kind`,`node_key`);
--> statement-breakpoint
CREATE INDEX `idx_graph_node_user_kind` ON `graph_nodes` (`user_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `graph_edges` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `kind` text NOT NULL,
  `src_id` integer NOT NULL,
  `dst_id` integer NOT NULL,
  `weight` real,
  `data` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_graph_edge_user_kind` ON `graph_edges` (`user_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `idx_graph_edge_src` ON `graph_edges` (`user_id`,`src_id`);
--> statement-breakpoint
CREATE INDEX `idx_graph_edge_dst` ON `graph_edges` (`user_id`,`dst_id`);
--> statement-breakpoint
CREATE TABLE `user_graph_meta` (
  `user_id` integer PRIMARY KEY NOT NULL,
  `content_hash` text,
  `node_count` integer DEFAULT 0 NOT NULL,
  `edge_count` integer DEFAULT 0 NOT NULL,
  `built_at` integer
);
