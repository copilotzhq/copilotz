/** Shared catalog DDL. Format selection is internal, never caller-supplied SQL. */
import type { OperationCatalogTables } from "./catalog.ts";
import {
  OPERATION_CATALOG_FINGERPRINT,
  OWNER_CONTENT_CATALOG_FINGERPRINT,
} from "../events/catalog-format.ts";

export function selectionSchemaStatements(
  tables: OperationCatalogTables,
): readonly string[] {
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_events_ordinal_idx"
    ON ${tables.operationEvents} (namespace, operation_id, event_ordinal)`,
    `CREATE TABLE IF NOT EXISTS ${tables.selectionHeads} (
    namespace TEXT NOT NULL,
    selection_key TEXT NOT NULL,
    change_ordinal BIGINT NOT NULL CHECK (change_ordinal >= 0),
    PRIMARY KEY (namespace, selection_key)
  )`,
    `CREATE TABLE IF NOT EXISTS ${tables.selectionOperations} (
    namespace TEXT NOT NULL,
    selection_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    change_ordinal BIGINT NOT NULL CHECK (change_ordinal >= 1),
    PRIMARY KEY (namespace, selection_key, operation_id)
  )`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_selections_changes_idx"
    ON ${tables.selectionOperations} (namespace, selection_key, change_ordinal, operation_id)`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_selections_operation_idx"
    ON ${tables.selectionOperations} (namespace, operation_id, selection_key)`,
  ];
}

/** Additive operational tables; the Core Event schema is unchanged. */
export function lifecycleIndexStatements(
  tables: OperationCatalogTables,
): readonly string[] {
  return [
    `CREATE INDEX IF NOT EXISTS "copilotz_operations_live_idx"
     ON ${tables.operations} (updated_at, operation_id) WHERE state IN ('accepted','running')`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_action_scope_idx"
     ON ${tables.operationStreams} (namespace, operation_id, ((descriptor -> 'metadata' ->> 'sourceActionScopeId')))
     WHERE (descriptor -> 'metadata' ->> 'sourceActionScopeId') IS NOT NULL`,
  ];
}

export function operationCatalogSchemaStatements(
  tables: OperationCatalogTables,
  format: "legacy" | "owner-content" = "legacy",
): readonly string[] {
  if (format !== "legacy" && format !== "owner-content") {
    throw new TypeError("Invalid catalog format.");
  }
  // The SQL binding bound is a materialization ceiling. The existing placement
  // parser enforces16KiB canonical JSON before command capture; JSONB::text adds
  // formatting whitespace, so the physical representation has32KiB headroom.
  const owner = format === "owner-content";
  const fingerprint = owner
    ? OWNER_CONTENT_CATALOG_FINGERPRINT
    : OPERATION_CATALOG_FINGERPRINT;
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.metadata} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      fingerprint TEXT NOT NULL CHECK (fingerprint = '${fingerprint}')
    )`,
    `CREATE TABLE IF NOT EXISTS ${tables.operations} (
      operation_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      root_event_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
      correlation_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_stream_ordinal BIGINT NOT NULL DEFAULT 1,
      next_event_ordinal BIGINT NOT NULL DEFAULT 1,
      observation_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      state TEXT NOT NULL CHECK (state IN ('accepted','running','completed','failed','cancelled')),
      accepted_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      cancellation_requested_at TIMESTAMPTZ,
      cancellation_reason TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operations_public_root_idx"
       ON ${tables.operations} (root_event_id) WHERE visibility = 'public'`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operations_namespace_updated_idx"
      ON ${tables.operations} (namespace, updated_at, operation_id)`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operations_metadata_idx"
      ON ${tables.operations} USING GIN (metadata jsonb_path_ops)`,
    `CREATE TABLE IF NOT EXISTS ${tables.operationEvents} (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_position BIGINT NOT NULL,
      event_ordinal BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (namespace, operation_id, event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_events_position_idx"
      ON ${tables.operationEvents} (namespace, operation_id, event_position)`,
    ...selectionSchemaStatements(tables),
    `CREATE TABLE IF NOT EXISTS ${tables.operationStreams} (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      replay_key BIGSERIAL NOT NULL UNIQUE,
      stream_ordinal BIGINT${owner ? "" : " NOT NULL"},
      stream_id TEXT NOT NULL,
      semantic_stream_id TEXT NOT NULL,
      body_id TEXT NOT NULL,
      descriptor JSONB NOT NULL,${
      owner
        ? `
      owner_id TEXT NOT NULL,
      opening_owner_epoch BIGINT NOT NULL CONSTRAINT owner_stream_epoch_check
        CHECK (opening_owner_epoch >= 1 AND opening_owner_epoch <= 9007199254740991),
      delivery_attempt BIGINT NOT NULL CONSTRAINT owner_stream_attempt_check
        CHECK (delivery_attempt >= 1 AND delivery_attempt <= 9007199254740991),
      placement_binding JSONB NOT NULL CONSTRAINT owner_stream_binding_check
        CHECK ((octet_length(placement_binding::text) <= 32768
          AND jsonb_typeof(placement_binding) = 'object'
          AND placement_binding ->> 'namespace' = namespace) IS TRUE),
      physical_backend_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      writer_generation BIGINT NOT NULL CONSTRAINT owner_stream_generation_check
        CHECK (writer_generation >= 1 AND writer_generation <= 9007199254740990),
      protection_deadline TIMESTAMPTZ NOT NULL CONSTRAINT owner_stream_deadline_check
        CHECK (isfinite(protection_deadline)),
      revocation_state TEXT NOT NULL CONSTRAINT owner_stream_revocation_check
        CHECK (revocation_state IN ('active','revoking','revoked')),
      CONSTRAINT owner_stream_descriptor_check CHECK ((jsonb_typeof(descriptor) = 'object'
        AND descriptor ->> 'type' = 'stream.output'
        AND descriptor ->> 'namespace' = namespace
        AND descriptor ->> 'streamId' = stream_id) IS TRUE),
      CONSTRAINT owner_stream_offset_check CHECK (committed_offset <= 9007199254740991),
      CONSTRAINT owner_stream_publication_ordinal_check CHECK (((state = 'reserving' AND stream_ordinal IS NULL)
        OR (state <> 'reserving' AND stream_ordinal >= 1 AND stream_ordinal <= 9007199254740991)) IS TRUE),
      CONSTRAINT owner_stream_reservation_offset_check CHECK (state <> 'reserving' OR committed_offset = 0),
      CONSTRAINT owner_stream_terminal_revocation_check CHECK (state <> 'terminal' OR revocation_state = 'revoked'),
      CONSTRAINT owner_stream_physical_key UNIQUE (physical_backend_id,body_id),`
        : ""
    }
      state TEXT NOT NULL CONSTRAINT copilotz_operation_streams_state_check
        CHECK (state IN (${
      owner ? "'reserving'," : ""
    }'open','terminating','terminal')),
      outcome TEXT CONSTRAINT copilotz_operation_streams_outcome_check
        CHECK (outcome IN ('completed','failed','cancelled','superseded','abandoned')),
      availability TEXT NOT NULL DEFAULT 'retained'
        CONSTRAINT copilotz_operation_streams_availability_check
        CHECK (availability IN ('retained','purge_pending','purged','missing')),
      capture TEXT CONSTRAINT copilotz_operation_streams_capture_check
        CHECK (capture IN ('complete','truncated')),
      committed_offset BIGINT NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
      digest TEXT,
      asset_id TEXT,
      asset_retention TEXT CHECK (asset_retention IN ('canonical','observation')),
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, operation_id, stream_id),
      UNIQUE (namespace, stream_id),
      UNIQUE (namespace, operation_id, stream_ordinal),
      CONSTRAINT copilotz_operation_streams_terminal_check CHECK (
        (${
      owner ? "state IN ('reserving','open')" : "state = 'open'"
    } AND outcome IS NULL AND capture IS NULL
          AND terminal_at IS NULL AND availability = 'retained')
        OR
        (state = 'terminating' AND outcome IS NOT NULL
          AND capture IS NOT NULL AND terminal_at IS NULL
          AND availability = 'retained'
          AND (outcome <> 'completed' OR capture = 'complete'))
        OR
        (state = 'terminal' AND outcome IS NOT NULL AND capture IS NOT NULL
          AND terminal_at IS NOT NULL
          AND (outcome <> 'completed' OR capture = 'complete')
          AND (asset_retention <> 'canonical' OR outcome = 'completed'))
      )
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_streams_replay_key_idx"
       ON ${tables.operationStreams} (replay_key)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_streams_ordinal_idx"
       ON ${tables.operationStreams} (namespace, operation_id, stream_ordinal)`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_semantic_idx"
       ON ${tables.operationStreams} (namespace, operation_id, semantic_stream_id)`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_body_idx"
       ON ${tables.operationStreams} (body_id)`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_retention_idx"
      ON ${tables.operationStreams} (
        asset_retention, availability, namespace, operation_id, stream_id
      ) WHERE state = 'terminal'`,
    ...lifecycleIndexStatements(tables),
    ...(owner
      ? [
        `CREATE TABLE IF NOT EXISTS ${tables.logicalBodies} (
          namespace TEXT NOT NULL,
          logical_body_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          settlement_scope_id TEXT NOT NULL,
          producer_stream_id TEXT,
          producer JSONB NOT NULL CONSTRAINT owner_body_producer_check
            CHECK ((jsonb_typeof(producer)='object' AND octet_length(producer::text)<=16384) IS TRUE),
          media_type TEXT NOT NULL,
          byte_length BIGINT NOT NULL CONSTRAINT owner_body_length_check
            CHECK (byte_length >= 0 AND byte_length <= 9007199254740991),
          digest TEXT NOT NULL CONSTRAINT owner_body_digest_check
            CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
          current_copy JSONB NOT NULL CONSTRAINT owner_body_current_copy_check
            CHECK ((jsonb_typeof(current_copy)='object' AND octet_length(current_copy::text)<=16384) IS TRUE),
          pending_ref TEXT NOT NULL,
          pending_descriptor JSONB NOT NULL CONSTRAINT owner_body_descriptor_check
            CHECK ((jsonb_typeof(pending_descriptor)='object' AND octet_length(pending_descriptor::text)<=131072) IS TRUE),
          protected_until TIMESTAMPTZ NOT NULL CONSTRAINT owner_body_protection_check CHECK (isfinite(protected_until)),
          adoption_key TEXT,
          adoption_fingerprint TEXT CONSTRAINT owner_body_adoption_fingerprint_check
            CHECK (adoption_fingerprint IS NULL OR adoption_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
          asset_id TEXT,
          domain_owner_id TEXT,
          domain_owner_type TEXT,
          pending_promotion JSONB CONSTRAINT owner_body_promotion_check
            CHECK (pending_promotion IS NULL OR (jsonb_typeof(pending_promotion)='object' AND octet_length(pending_promotion::text)<=16384) IS TRUE),
          retired_at TIMESTAMPTZ CONSTRAINT owner_body_retired_check CHECK (retired_at IS NULL OR isfinite(retired_at)),
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(namespace,logical_body_id),
          CONSTRAINT owner_body_adoption_check CHECK (
            (adoption_key IS NULL AND adoption_fingerprint IS NULL AND asset_id IS NULL AND domain_owner_id IS NULL AND domain_owner_type IS NULL)
            OR (adoption_key IS NOT NULL AND adoption_fingerprint IS NOT NULL AND asset_id IS NOT NULL AND domain_owner_id IS NOT NULL AND domain_owner_type IS NOT NULL))
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_bodies_pending_idx" ON ${tables.logicalBodies}(namespace,pending_ref)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_bodies_adoption_idx" ON ${tables.logicalBodies}(namespace,adoption_key) WHERE adoption_key IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_bodies_asset_idx" ON ${tables.logicalBodies}(namespace,asset_id) WHERE asset_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS "copilotz_operation_bodies_producer_idx" ON ${tables.logicalBodies}(owner_id,settlement_scope_id)`,
        `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_renewal_idx"
       ON ${tables.operationStreams} (owner_id, protection_deadline, namespace, operation_id, stream_id)
       WHERE revocation_state <> 'revoked'`,
      ]
      : []),
  ];
}
