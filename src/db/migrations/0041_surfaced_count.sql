-- T4: re-surfacing cool-off. Track how many times the inventory has surfaced
-- a repo to a user without them acting on it, so the skill can apply a
-- "shown N times → cool off / stop" rule instead of re-serving the same
-- candidates every session until they're starred or hidden.
--
-- Existing rows default to 0; the next 'surfaced' record bumps them. The
-- cool-off window is driven off surfaced_at (now the MOST-RECENT surfacing
-- time for 'surfaced' rows) in src/app/api/inventory/today/route.ts.
ALTER TABLE user_match_state ADD COLUMN surfaced_count INTEGER NOT NULL DEFAULT 0;
