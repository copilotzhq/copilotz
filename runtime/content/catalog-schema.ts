/** Catalog-owned logical bodies. Physical adapters contain no liveness authority. */
export const CONTENT_CATALOG_COLUMNS = {
  content_logical_bodies: [
    "body_id",
    "namespace",
    "current_copy",
    "writer_id",
    "generation",
    "revocation",
    "protected_until",
    "committed_offset",
    "seal_intent",
    "terminal",
    "promotion_target",
    "recovery_after",
  ],
  content_copies: [
    "copy_key",
    "backend_kind",
    "backend_id",
    "body_id",
    "version_token",
    "state",
    "collectable",
    "retire_after",
  ],
  pending_content: [
    "namespace",
    "pending_ref",
    "body_id",
    "producer",
    "descriptor",
    "expires_at",
  ],
  content_adoptions: ["namespace", "pending_ref", "owner_id", "asset_id"],
} as const;

export function contentCatalogStatements(schema: string): readonly string[] {
  const table = (name: string) => `"${schema}"."${name}"`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table("content_logical_bodies")} (
      body_id TEXT COLLATE "C" PRIMARY KEY, namespace TEXT COLLATE "C" NOT NULL,
      current_copy TEXT COLLATE "C" NOT NULL, writer_id TEXT COLLATE "C" NOT NULL,
      generation BIGINT NOT NULL CHECK (generation > 0),
      revocation TEXT NOT NULL DEFAULT 'active' CHECK (revocation IN ('active','revoking','revoked')),
      protected_until TIMESTAMPTZ NOT NULL,
      committed_offset BIGINT NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
      seal_intent JSONB, terminal JSONB, promotion_target JSONB, recovery_after TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS content_logical_recovery_due_idx ON ${
      table("content_logical_bodies")
    } ((COALESCE(recovery_after,protected_until)),body_id) WHERE terminal IS NULL`,
    `CREATE INDEX IF NOT EXISTS content_logical_promotion_due_idx ON ${
      table("content_logical_bodies")
    } ((promotion_target->>'expiresAt')) WHERE promotion_target IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS content_logical_protection_due_idx ON ${
      table("content_logical_bodies")
    } (protected_until,body_id) WHERE terminal IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${table("content_copies")} (
      copy_key TEXT COLLATE "C" PRIMARY KEY, backend_kind TEXT NOT NULL, backend_id TEXT COLLATE "C" NOT NULL,
      body_id TEXT COLLATE "C" NOT NULL REFERENCES ${
      table("content_logical_bodies")
    }(body_id),
      version_token TEXT COLLATE "C", collectable BOOLEAN NOT NULL DEFAULT FALSE, retire_after TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '24 hours'), state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved','current','target','orphan','retiring','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS content_copies_body_idx ON ${
      table("content_copies")
    }(body_id)`,
    `CREATE INDEX IF NOT EXISTS content_copies_retirement_due_idx ON ${
      table("content_copies")
    } (retire_after,body_id,copy_key) WHERE collectable AND state IN ('current','orphan','retiring')`,
    `CREATE TABLE IF NOT EXISTS ${table("pending_content")} (
      namespace TEXT COLLATE "C" NOT NULL, pending_ref TEXT COLLATE "C" NOT NULL, body_id TEXT COLLATE "C" NOT NULL
        REFERENCES ${table("content_logical_bodies")}(body_id),
      producer TEXT NOT NULL, descriptor JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(namespace,pending_ref)
    )`,
    `CREATE INDEX IF NOT EXISTS pending_content_expiry_idx ON ${
      table("pending_content")
    } (expires_at,namespace,pending_ref)`,
    `CREATE INDEX IF NOT EXISTS pending_content_body_expiry_idx ON ${
      table("pending_content")
    } (body_id,expires_at) INCLUDE (namespace,producer)`,
    `CREATE TABLE IF NOT EXISTS ${table("content_adoptions")} (
      namespace TEXT COLLATE "C" NOT NULL, pending_ref TEXT COLLATE "C" NOT NULL, owner_id TEXT COLLATE "C" NOT NULL,
      asset_id TEXT COLLATE "C" NOT NULL, PRIMARY KEY(namespace,pending_ref),
      FOREIGN KEY(namespace,pending_ref) REFERENCES ${
      table("pending_content")
    }(namespace,pending_ref)
    )`,
  ];
}
