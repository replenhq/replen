-- Library-vs-hype classification. Keep only adoptable repos (library/framework/
-- app); filter viral experiments + curated content ("skills" repos, prompt
-- lists). See src/catalogue/classify.ts.
ALTER TABLE `catalogue_repos` ADD COLUMN `kind` text;
