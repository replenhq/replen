CREATE TABLE `repo_indexes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `repo_id` integer NOT NULL,
  `readme_sha` text,
  `built_at` integer NOT NULL,
  `chunk_count` integer NOT NULL,
  `byte_count` integer NOT NULL,
  `index_version` text NOT NULL,
  `total_tokens` integer NOT NULL,
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo_index_version` ON `repo_indexes` (`repo_id`,`index_version`);--> statement-breakpoint
CREATE INDEX `idx_repo_indexes_built` ON `repo_indexes` (`built_at`);--> statement-breakpoint
CREATE TABLE `repo_chunks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `index_id` integer NOT NULL,
  `file_path` text NOT NULL,
  `start_line` integer NOT NULL,
  `end_line` integer NOT NULL,
  `language` text,
  `content` text NOT NULL,
  `doc_length` integer NOT NULL,
  FOREIGN KEY (`index_id`) REFERENCES `repo_indexes`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_repo_chunks_index` ON `repo_chunks` (`index_id`);--> statement-breakpoint
CREATE TABLE `repo_chunk_terms` (
  `index_id` integer NOT NULL,
  `term` text NOT NULL,
  `chunk_id` integer NOT NULL,
  `freq` integer NOT NULL,
  PRIMARY KEY (`index_id`,`term`,`chunk_id`),
  FOREIGN KEY (`index_id`) REFERENCES `repo_indexes`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`chunk_id`) REFERENCES `repo_chunks`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_repo_chunk_terms_term` ON `repo_chunk_terms` (`index_id`,`term`);
