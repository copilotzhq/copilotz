# Offline owner keys and portable bundles

Runtime schema version 12 uses one random 64-byte owner key: independent 256-bit
AES-GCM and HMAC-SHA256 keys. The owner's `owner_data_keys` table stores only
its wrapped material, public adapter envelope, and key identity. The
application’s existing `adapters.secrets.default` adapter now wraps and unwraps
this material; it no longer encrypts each protected value. Wrapping binds schema
and key identity. Value authentication still binds schema, namespace, record
owner, and slot. Random 96-bit nonces are generated for each encryption.
Rewrapping preserves ciphertexts, references, and commitments. There is no
old-format runtime reader.

Stop intake, owners, maintenance, and physical producers before these
operations. The scripts check the durable drain state and lock tables, but
cannot stop an external producer or update deployment routing. Use an offline
backup and rehearse on a copy. These scripts have been exercised only on
generated fixtures.

## Configuration and commands

Use a local TypeScript module whose default export supplies
`OwnerTransferConfig` from `@copilotz/copilotz/migration`:

- `sourceAdapter`: the original platform adapter (the old direct-value adapter
  when migrating v11).
- `destinationAdapter`: the destination platform adapter, with durable key
  access.
- `readExternalBody`: for object bodies, a reader that resolves the explicit
  backend ID and namespace. `bodyStoreReader(storeFor)` supports S3, native GCS,
  and custom BodyStores. Migration of the old hashed S3 layout must instead use
  `oldS3BodyReader(config)` from `@copilotz/copilotz/migration`. A configuration
  with several backends must dispatch explicitly by backend ID.
- `bindings`: optional original coordinates and reference for custom protected
  captures. The migration infers standard protected Event and Action lifecycle
  bindings, including historical receipts. Missing or ambiguous bindings abort.

Keep credentials in the deployment’s secret provider, outside the bundle. For
export, both source and destination adapters must be accessible to the offline
process. The raw data key exists only in memory; no plaintext key is serialized.

```sh
# The connection is always explicit; no default database is modified.
export COPILOTZ_TRANSFER_DATABASE_URL='postgres://...'

deno run -A scripts/owner-bundle.ts migrate --schema=scope_a \
  --config=/absolute/path/key-transfer.ts --offline

deno run -A scripts/owner-bundle.ts export --schema=scope_a \
  --bundle=/absolute/path/new-bundle --config=/absolute/path/key-transfer.ts --offline

# Change the connection to the destination database before importing.
deno run -A scripts/owner-bundle.ts import \
  --bundle=/absolute/path/new-bundle --config=/absolute/path/key-transfer.ts --offline
```

Migration accepts v11 only, reencrypts each retained protected body once,
rewrites all copies of protected references in JSON columns, updates protected
nodes and Event Body digests, and publishes schema version 12 in one SQL
transaction. A failed conversion rolls back the key, bytes, references, and
version. Event immutability is restored before commit. Earlier protected schemas
first need the prior release's upgrade to v11. Ordinary provisioning never
migrates retained data.

The bundle contains `schema.dump` (a PostgreSQL custom archive of one schema,
including rows, indexes, constraints, sequences, and functions), `bodies.json`
(verified current body prefixes, including failed/cancelled terminals), and
`manifest.json` (checksums and the destination-wrapped key). The dump omits the
source wrapped-key row and readiness marker. Export uses one exported PostgreSQL
snapshot with shared table locks. It never modifies source data.

Import requires an empty destination schema in another PostgreSQL database. It
preserves the schema name because schema is authenticated data. `pg_dump` and
`pg_restore` must be on PATH and compatible with the server. Install any
required extensions in the destination first. Only import trusted bundles:
PostgreSQL archives contain executable DDL. Checksums detect corruption, not an
untrusted archive author.

Import verifies checksums and the destination key before restoration. It
restores the archive in one transaction, then installs body copies and the
wrapped key and sets readiness in a second transaction. It advances the imported
epoch and assigns a fresh holder identity, preserving the sequence and logical
receipts while preventing attachment to a source owner still alive in the same
process. A failure after archive restoration leaves an unready schema: discard
that failed destination schema and retry into an empty one. It never overwrites
an existing owner's tables.

All current bodies are restored into the destination schema's database
BodyStore, with fresh `schemas/<schema>/imported/<id>` physical keys; logical
body IDs and protected references stay stable. Future writes may use the
application's chosen object adapter. This minimal tool holds the body inventory
in memory and is not a streaming bulk-transfer implementation.

## Storage and operational decisions

Database body tables already belong to the owner schema. Native GCS preserves
the schema-bearing key. S3 now stores manifests and parts under
`bodies/<deployment-prefix-hash>/schemas/<schema>/<identity-hash>/`.
Schema-scoped maintenance lists only that owner's prefix. Direct adapter callers
without a schema-bearing identity use a separate `unscoped/` prefix; the runtime
supplies schema-bearing identities for assets, streams, and protected values.
Deployments sharing one bucket across databases with repeated schema names must
use distinct deployment prefixes.

Migration copies old object bytes into the database and changes catalog
locations atomically. Source cloud objects are intentionally not deleted: a SQL
rollback cannot undo a cloud deletion. Old cloud-copy records remain
uncollectable so they cannot be mistaken for active destination copies. After
verifying the migrated owner and backup, operators must retire those source
copies with the original backend/version records. Existing unrelated
orphan/retired copies and tombstones are not adopted. Bundles carry current
retained content; external garbage is not copied. Database staging copies of
migrated bodies are removed atomically.

Operations must choose where the platform key lives (for example a KMS-backed
adapter), its backup and rotation policy, bundle access/retention, the
write-freeze and routing cutover, and cleanup of old object copies. The library
does not create or persist a platform master key. Schema renaming and
concurrent/live transfers are outside this minimal capability.
