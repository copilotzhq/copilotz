-- =============================================================================
-- Migrate legacy `user` graph nodes → unified `participant` (Copilotz)
-- =============================================================================
-- Equivalent to: scripts/migrate-users-to-participants.ts
--
-- How to use
-- ----------
-- 1. Set `v_filter_source_id` below:
--      NULL  = migrate every legacy user node
--      '...' = only rows where nodes.source_id matches (like --user=... in Deno)
-- 2. Run the whole script in your SQL client (pgAdmin, Neon, Supabase, etc.).
--    Messages / NOTICE output shows row counts (check the Messages panel if the
--    UI hides notices).
-- 3. Restart your Copilotz instance afterward so collection indexes can rebuild.
--
-- Optional: wrap the DO block in BEGIN; ... COMMIT; for a single transaction.
-- =============================================================================

DO $$
DECLARE
  -- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  -- Set this: NULL = all users, or a single source_id string to limit scope.
  v_filter_source_id text := NULL;
  -- <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

  n bigint;
BEGIN
  -- 1. Re-label 'user' nodes as 'participant'
  UPDATE "nodes"
  SET "type" = 'participant'
  WHERE "type" = 'user'
    AND (
      v_filter_source_id IS NULL
      OR "source_id" = v_filter_source_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Updated type column for % node(s).', n;

  -- 2. Ensure 'participantType' exists in JSON
  UPDATE "nodes"
  SET "data" = "data" || jsonb_build_object(
    'participantType',
    CASE WHEN "source_type" = 'agent' THEN 'agent' ELSE 'human' END
  )
  WHERE "type" = 'participant'
    AND ("data"->>'participantType') IS NULL
    AND (
      v_filter_source_id IS NULL
      OR "source_id" = v_filter_source_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Ensured participantType in JSON for % node(s).', n;

  -- 3. Ensure 'externalId' exists in JSON
  UPDATE "nodes"
  SET "data" = "data" || jsonb_build_object('externalId', "source_id")
  WHERE "type" = 'participant'
    AND ("data"->>'externalId') IS NULL
    AND (
      v_filter_source_id IS NULL
      OR "source_id" = v_filter_source_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Ensured externalId in JSON for % node(s).', n;

  -- 4. Identity namespace widening (strip :thread:... suffix)
  UPDATE "nodes"
  SET "namespace" = split_part("namespace", ':thread:', 1)
  WHERE "type" = 'participant'
    AND "namespace" LIKE '%:thread:%'
    AND (
      v_filter_source_id IS NULL
      OR "source_id" = v_filter_source_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Widened namespace for % node(s).', n;

  RAISE NOTICE 'Migration finished. Restart Copilotz to trigger new index creation.';
END
$$;
