-- Agentic onboarding: the coding agent's grounded project report (a
-- comprehensive code-read write-up). Stored server-side as an additional
-- grounding input to the safety-net summarization; richer than the docs alone.
-- NULL until the onboarding sweep runs.
ALTER TABLE `project_profiles` ADD COLUMN `agent_report` text;
