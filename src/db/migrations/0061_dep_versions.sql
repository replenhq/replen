-- Version reporting: pinned dependency/runtime versions per project, sent by
-- the in-session agent (names + versions only, never code).
ALTER TABLE `project_profiles` ADD COLUMN `dep_versions` text;
