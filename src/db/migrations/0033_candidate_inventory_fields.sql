-- Pipeline v2 / Sprint 1 (Inventory): tag each candidate at insert time
-- with the structural fields downstream stages need for cheap eligibility
-- filtering. Without these, Stage 2 has to either reload the underlying
-- GitHub repo metadata (expensive, rate-limited) or rely on the LLM to
-- infer them from prose (wasteful, slow, drifts).
--
--   primary_language : GitHub's repo-level primary language ("TypeScript",
--                      "Python", null when unknown). Used by the language-
--                      family eligibility rule.
--   topics           : JSON array of GitHub topic tags. Drives the shape
--                      classifier + the SDK / aggregator filter.
--   repo_shape       : enum-shaped string. One of: library, framework, app,
--                      template, tutorial, aggregator, unknown. Inferred at
--                      insert from name + topics + description (see
--                      src/fetchers/repo-shape.ts). Lets Stage 2 drop
--                      awesome-lists, tutorials, and platform-class repos
--                      before they reach the expensive scoring stage.
ALTER TABLE `candidates` ADD `primary_language` text;
--> statement-breakpoint
ALTER TABLE `candidates` ADD `topics` text;
--> statement-breakpoint
ALTER TABLE `candidates` ADD `repo_shape` text;
