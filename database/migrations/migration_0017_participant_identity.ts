/**
 * Makes participant identities and thread membership canonical.
 *
 * Earlier versions treated both invariants as application conventions. That
 * allowed concurrent/replayed lifecycle work to create duplicate participant
 * nodes and duplicate `participates_in` edges.
 */
export const generateParticipantIdentityMigrations = (): string => `
CREATE OR REPLACE FUNCTION "copilotz_jsonb_deep_merge"(
  "left_value" JSONB,
  "right_value" JSONB
) RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  "result" JSONB := COALESCE("left_value", '{}'::jsonb);
  "entry" RECORD;
BEGIN
  IF "right_value" IS NULL THEN
    RETURN "result";
  END IF;
  IF jsonb_typeof("result") <> 'object' OR jsonb_typeof("right_value") <> 'object' THEN
    RETURN "right_value";
  END IF;

  FOR "entry" IN SELECT "key", "value" FROM jsonb_each("right_value")
  LOOP
    IF
      "result" ? "entry"."key"
      AND jsonb_typeof("result" -> "entry"."key") = 'object'
      AND jsonb_typeof("entry"."value") = 'object'
    THEN
      "result" := jsonb_set(
        "result",
        ARRAY["entry"."key"],
        "copilotz_jsonb_deep_merge"(
          "result" -> "entry"."key",
          "entry"."value"
        ),
        true
      );
    ELSE
      "result" := jsonb_set(
        "result",
        ARRAY["entry"."key"],
        "entry"."value",
        true
      );
    END IF;
  END LOOP;

  RETURN "result";
END;
$$;

DO $$
DECLARE
  "identity_group" RECORD;
  "participant" RECORD;
  "merged_data" JSONB;
BEGIN
  IF
    to_regclass(
      format('%I.%I', current_schema(), 'uidx_nodes_participant_identity')
    ) IS NOT NULL
    AND to_regclass(
      format('%I.%I', current_schema(), 'uidx_edges_participates_in')
    ) IS NOT NULL
  THEN
    RETURN;
  END IF;

  LOCK TABLE "nodes", "edges" IN SHARE ROW EXCLUSIVE MODE;

  FOR "identity_group" IN
    SELECT
      "namespace",
      COALESCE("data" ->> 'externalId', "source_id") AS "external_id",
      (array_agg("id" ORDER BY "created_at" DESC, "id" DESC))[1] AS "canonical_id"
    FROM "nodes"
    WHERE
      "type" = 'participant'
      AND COALESCE("data" ->> 'externalId', "source_id") IS NOT NULL
      AND COALESCE("data" ->> 'externalId', "source_id") <> ''
    GROUP BY
      "namespace",
      COALESCE("data" ->> 'externalId', "source_id")
    HAVING COUNT(*) > 1
  LOOP
    "merged_data" := '{}'::jsonb;

    FOR "participant" IN
      SELECT "id", "data"
      FROM "nodes"
      WHERE
        "type" = 'participant'
        AND "namespace" = "identity_group"."namespace"
        AND COALESCE("data" ->> 'externalId', "source_id") =
          "identity_group"."external_id"
      ORDER BY "created_at" ASC, "id" ASC
    LOOP
      "merged_data" := "copilotz_jsonb_deep_merge"(
        "merged_data",
        COALESCE("participant"."data", '{}'::jsonb)
      );
    END LOOP;

    "merged_data" := jsonb_set(
      "merged_data",
      '{externalId}',
      to_jsonb("identity_group"."external_id"),
      true
    );

    UPDATE "nodes"
    SET
      "data" = "merged_data",
      "source_type" = COALESCE(
        "source_type",
        CASE
          WHEN "merged_data" ->> 'participantType' = 'human' THEN 'user'
          ELSE "merged_data" ->> 'participantType'
        END
      ),
      "source_id" = "identity_group"."external_id"
    WHERE "id" = "identity_group"."canonical_id";

    UPDATE "edges"
    SET "source_node_id" = "identity_group"."canonical_id"
    WHERE "source_node_id" IN (
      SELECT "id"
      FROM "nodes"
      WHERE
        "type" = 'participant'
        AND "namespace" = "identity_group"."namespace"
        AND COALESCE("data" ->> 'externalId', "source_id") =
          "identity_group"."external_id"
        AND "id" <> "identity_group"."canonical_id"
    );

    UPDATE "edges"
    SET "target_node_id" = "identity_group"."canonical_id"
    WHERE "target_node_id" IN (
      SELECT "id"
      FROM "nodes"
      WHERE
        "type" = 'participant'
        AND "namespace" = "identity_group"."namespace"
        AND COALESCE("data" ->> 'externalId', "source_id") =
          "identity_group"."external_id"
        AND "id" <> "identity_group"."canonical_id"
    );

    DELETE FROM "nodes"
    WHERE
      "type" = 'participant'
      AND "namespace" = "identity_group"."namespace"
      AND COALESCE("data" ->> 'externalId', "source_id") =
        "identity_group"."external_id"
      AND "id" <> "identity_group"."canonical_id";
  END LOOP;

  DELETE FROM "edges"
  WHERE "id" IN (
    SELECT "id"
    FROM (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "source_node_id", "target_node_id", "type"
          ORDER BY "created_at" ASC, "id" ASC
        ) AS "duplicate_number"
      FROM "edges"
      WHERE "type" = 'participates_in'
    ) AS "ranked_edges"
    WHERE "duplicate_number" > 1
  );

  CREATE UNIQUE INDEX IF NOT EXISTS "uidx_nodes_participant_identity"
    ON "nodes" (
      "namespace",
      (COALESCE("data" ->> 'externalId', "source_id"))
    )
    WHERE
      "type" = 'participant'
      AND COALESCE("data" ->> 'externalId', "source_id") IS NOT NULL
      AND COALESCE("data" ->> 'externalId', "source_id") <> '';

  CREATE UNIQUE INDEX IF NOT EXISTS "uidx_edges_participates_in"
    ON "edges" ("source_node_id", "target_node_id", "type")
    WHERE "type" = 'participates_in';
END;
$$;

DROP FUNCTION IF EXISTS "copilotz_jsonb_deep_merge"(JSONB, JSONB);
`;
