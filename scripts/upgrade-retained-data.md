# Upgrade retained data offline

Current schema: **v14**. There is one chain:

```text
v5–v10 --reviewed retained data--> v11 --owner keys--> v12 --authority--> v13 --credential effects and flow admission--> v14
```

This is never an activation fallback. Back up and rehearse on a disposable copy.
Stop intake, schedules, workers, owners and every physical writer throughout the
chain. Every conversion locks the schema and refuses undrained work.

Run commands as `deno run -A scripts/upgrade-retained-data.ts ...` with
`COPILOTZ_MIGRATION_DATABASE_URL` set. Use one physical schema at a time.

1. `drain --schema=SCHEMA`: inspect deliveries, obligations, operations,
   streams, begun external effects and physical writers. All must be terminal;
   cancellation requests alone do not qualify. Drain application-owned sagas
   through the application's own procedure too.
2. Starting at v5–v10, run `prepare --schema=SCHEMA --plan=review.json`.
   Preparation converts physical storage and stream taxonomy, records source and
   target **v11**, and commits reserved marker `0`. Keep the plan privately with
   the backup. Review every copy, reference and execution-owned Asset. Supply
   explicit ownership/collection decisions using the
   [content decision format](migrate-action-content.md). Use
   `--storage=./migration-storage.ts` on prepare and apply for external
   inventories. The module maps explicit backends after any required physical
   import; see the storage example below.
3. Run
   `apply --schema=SCHEMA --plan=review.json --reviewed=FINGERPRINT
   --owner-keys=./migration-keys.ts`,
   adding `--decisions=decisions.json` if needed. Retained finalization commits
   v11, then owner-key conversion commits v12. Without an authority manifest the
   command deliberately exits with `copilotz_upgrade_authority_required`; v12 is
   a durable checkpoint, not permission to restart. If keys are omitted, it
   stops at v11 with `copilotz_upgrade_owner_keys_required`.
4. Starting or resuming at v11, use
   `apply --schema=SCHEMA --owner-keys=./migration-keys.ts`. Starting at v12,
   skip preparation and key conversion. Never change the marker manually.
5. At v12, run `authority-inventory --schema=SCHEMA > authority-inventory.json`.
   Build and review `authority.json` against the application's policy. Supply
   exact retained invocation/event digests and explicit authority bindings;
   unbound captures need original Action schema snapshots and unclassified
   ingress needs explicit provenance. Do not derive authority from worker IDs.
   Inspect after key conversion, which may change capture digests. An empty
   inventory still requires
   `{ "policies": [], "invocations": [], "events": [] }`.
6. Run `apply --schema=SCHEMA --authority=authority.json`. The authority step
   commits v13 and its manifest receipt, clears transport attachments and fences
   the owner epoch. The credential-effects step then adds private effect storage
   with indexed run/operation lookup and the accepted flow continuation binding
   in one v13 → v14 transaction. Validate, then activate.
7. Starting at v13, run `apply --schema=SCHEMA` with producers stopped and work
   drained. This additive step preserves sessions and retained authority and
   fences the owner epoch. No new manifest or key input is required. Replaying
   v14 preserves effect and flow bindings without advancing the epoch again.

`--owner-keys` is a trusted local TypeScript module path, resolved from the
working directory. It must default-export `OwnerKeyUpgradeOptions`:

```ts
import type { OwnerKeyUpgradeOptions } from "./runtime/actions/upgrade.ts";
import { masterAdapter, sourceAdapter } from "./application-migration-keys.ts";

export default {
  sourceAdapter, // Opens the original application-encrypted values.
  masterAdapter, // Wraps the new per-owner data key.
  // bindings: original coordinates for otherwise unclassified protected values,
  // readExternalBody: explicit reader for retained external copies,
} satisfies OwnerKeyUpgradeOptions;
```

The adapters come from the application; the script supplies no default key or
plaintext fallback. Keep secrets in the application's key provider, outside
plans and manifests. The standalone `scripts/migrate-owner-keys.ts` API shares
the same implementation and stops at v12.

For a fully reviewed inventory, one `apply` can include the retained plan,
reviewed fingerprint, decisions, key module and authority manifest and run all
steps through v14. The manifest must describe the inventory at v12. The
TypeScript equivalent is
`upgradeActionLifecycle(session, schema, { plan,
reviewedFingerprint, contentDecisions, ownerKeys, authority })`.

### Offline database deadlines and progress

The offline CLIs (`upgrade-retained-data.ts`, `migrate-action-content.ts`,
`migrate-ingress-provenance.ts`, `provision-content-indexes.ts`, and
`owner-bundle.ts`) disable the per-statement online deadline and allow a 24-hour
client request deadline. This does not change application connection defaults.
Use the same explicit options in application migration modules and `deno eval`
snippets:

```ts
const database = await openManagedOminipgDatabase({
  url: Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL"),
  statementTimeoutMs: null,
  requestTimeoutMs: 24 * 60 * 60 * 1000,
});
```

Setting only `statementTimeoutMs: null` leaves the default 30-second client
request deadline in place. A long transaction must fit within the client
deadline as well. Keep all producers stopped; these settings are for the
explicit offline connection, not the running application.

Long phases emit `[upgrade:SCHEMA] PHASE done/total` progress to **stderr**.
Stdout remains the CLI's JSON result, and review-plan fingerprints keep their
existing format. Progress within a transaction is not a committed checkpoint.
After interruption, inspect the durable marker and repeat the same reviewed
command; do not restart producers based on a progress line. Preparation and
finalization still verify retained bytes and event-body digests.

The native database path batches up to 2,000 records, with a 16 MiB byte budget
for physical reads. Individual large bodies retain the chunked prefix reader;
physical layout conversion can require memory for the largest individual body.
External heads and full prefix digests use bounded concurrency (default 16).
Rehearse using the same storage adapter and client/database hardware as the
cutover. See [the synthetic benchmark](benchmark-offline-upgrade.md) for
reproduction commands, measured results and their limits.

## Failure and retry

A failed transaction rolls back only its own step. Preparation commits marker
`0`; retained finalization commits v11; keys commit v12; authority commits v13;
credential effects and flow admission commit v14 together. None of the
intermediate versions can activate this release. Missing inputs raise
`UpgradeStepRequiredError`, with a stable `code`, `fromVersion`, and `toVersion`
naming the next step. Supply that input and rerun.

Repeat preparation with a new output path after a lost reply or failed
inventory. It returns the existing identity and physical versions; the CLI
refuses to overwrite a plan. Repeat finalization with the same reviewed plan and
decisions. Their persisted fingerprints remain checked even after later steps
have committed. Omitted and empty decision lists are equivalent, and ordering
does not change intent.

Key conversion atomically records its result with v12. A retry returns that
receipt without reencrypting or replacing bodies again. Authority conversion
records the exact accepted manifest fingerprint with v13; a changed manifest is
rejected on retry. A lost acknowledgement is an unknown outcome: inspect the
marker or repeat the same command. Never infer rollback or repair readiness by
hand. Changed physical copies, mixed plans, missing bytes and mismatched review
fingerprints are rejected; resolve the source problem or restore the backup.

## History and cursors

Historical `seq` follows the old canonical `position` order, across namespaces,
with allocation gaps removed. The old schema did not retain a global transaction
commit timestamp, so concurrent historical commit chronology cannot be
reconstructed. New owner writes are commit ordered and gap free. Positions,
event IDs, operation event ordinals, stream replay keys and byte offsets remain
unchanged, so historical observation cursors stay valid. No history compaction
or blanket cursor reset occurs during this upgrade.

The [real old-code fixture](fixtures/retained-upgrade/README.md) and
`runtime/actions/retained-upgrade.test.ts` exercise preparation, interruption,
replay, finalization and normal owner activation on PGlite and PostgreSQL.

## Receipt authority during offline conversion

The current v10 receipt shape separates the stable owner-resolved invocation
principal from the authenticated physical workers allowed to recover its
outcome. Replacement workers gain recovery rights only after an authorized exact
replay commits. Existing fixed-principal receipts retain their principal and
receive only that principal as a reader during the offline upgrade.

Historical logical Collection receipts bound only to a `worker:` principal do
not prove the original invocation authority. Preparation and finalization refuse
such rows without advancing readiness or mutating the source. Keep that schema
offline and retained. Resolving this case requires an independently reviewed
conversion backed by original durable invocation records; the current tool does
not accept a manual override, infer authority from a receipt key, or authorize
replacement workers to replay these rows. This case is not a supported upgrade
until that conversion exists. Fresh pre-conversion histories without owner
receipts and fixed-principal owner receipts remain supported.

Earlier unpublished v10 databases missing the required reader column are
rejected by normal schema validation. They must not be relabeled as an older
version or served through a compatibility path. Use a fresh disposable schema
for rehearsal; retain any non-disposable source for a separately reviewed
offline conversion.

Physical recovery readers use the authenticated `workerId`, matching the
existing receipt-recovery trust contract across sessions and owner epochs. The
host's admission layer must keep each worker ID bound to the same security
principal; it must never recycle an ID across unrelated principals or tenants. A
transport connection or attempt ID changing does not itself revoke that durable
identity.

## External storage during offline cutover

First use the pruner's `--list-unterminated`, review the digest-bound JSON,
dry-run `--abandoned=FILE.json`, then retire with `--apply --writers-stopped`.
Refused closures must be resolved before preparing. Retirement performs SQL
deletes only; it does not read, write or delete physical content.

Both `prepare` and `apply` accept `--storage=MODULE.ts`. The module
default-exports `RetainedDataUpgradeStorage`: optional `storeFor`,
`streamBackend`, `copyMappings` and `concurrency`. The CLI validates its shape
before opening the database. `storeFor(location, session)` may return
`undefined` for the platform database store. Unknown external backends still
fail closed. `--concurrency=16` overrides the module; the supported range is
1–256. Concurrency changes no plan fields or fingerprints. Duplicate physical
identities share one check, and conflicting length/digest/outcome claims still
fail.

For an S3-compatible backend, create `migration-storage.ts` in the repository
root (use the exact backend ID, bucket, prefix and protocol of the retained
data):

```ts
import { createBodyStorageRuntime } from "./runtime/content/storage.ts";
import type { RetainedDataUpgradeStorage } from "./runtime/actions/upgrade.ts";

const config = {
  backendId: Deno.env.get("MIGRATION_BACKEND_ID")!,
  endpoint: Deno.env.get("MIGRATION_S3_ENDPOINT")!,
  region: Deno.env.get("MIGRATION_S3_REGION")!,
  bucket: Deno.env.get("MIGRATION_S3_BUCKET")!,
  accessKeyId: Deno.env.get("MIGRATION_S3_ACCESS_KEY_ID")!,
  secretAccessKey: Deno.env.get("MIGRATION_S3_SECRET_ACCESS_KEY")!,
  prefix: Deno.env.get("MIGRATION_S3_PREFIX") ?? "",
  pathStyle: true,
};
const runtime = createBodyStorageRuntime({ storage: { type: "s3", config } });
const store = runtime.writer!;
export default {
  storeFor: (location) =>
    location.kind === "object" && location.backendId === store.backendId
      ? store
      : undefined,
  // Set this only if the retained operation streams use this external backend.
  // Otherwise omit it to retain the default database stream backend.
  // streamBackend: { kind: "object", backendId: store.backendId },
  concurrency: 16,
} satisfies RetainedDataUpgradeStorage;
```

For native GCS objects use the existing `createGcsBodyStore` adapter and map its
exact `object` backend ID in the same way. S3 compatibility does not convert
native GCS object layouts into S3 manifests. `copyMappings` points at already
imported physical keys; it does not perform copies. Keep credentials in the
environment, and use credentials that permit only reads for the external source.

```sh
deno run -A scripts/upgrade-retained-data.ts prepare --schema=SCHEMA \
  --storage=./migration-storage.ts --concurrency=16 --plan=review.json
# Review the plan and supply the required keys, ownership and authority inputs.
deno run -A scripts/upgrade-retained-data.ts apply --schema=SCHEMA \
  --storage=./migration-storage.ts --plan=review.json --reviewed=FINGERPRINT \
  --owner-keys=./migration-keys.ts
```

### Store operation audit

| Step                                     | External BodyStore operations                                                               | Writes                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pruner/list/retire and drain             | None                                                                                        | Retirement deletes approved SQL closures                                                                                                                         |
| Prepare                                  | `head`, `readRange` in 1 MiB digest chunks                                                  | Database physical-format/stream migration and reserved marker; no external mutations                                                                             |
| Retained finalization to v11             | Repeats `head`, `readRange` and digest verification                                         | SQL logical-body/copy catalog, ownership, document conversions and schema changes; no external mutations                                                         |
| Owner-key conversion to v12              | `head`, `readRange` via the storage module, unless `ownerKeys.readExternalBody` is supplied | Imports external bytes into database-owned copies and rewrites protected values; marks source catalog copies orphan/noncollectable; leaves source objects intact |
| Authority/v13 and credential effects/v14 | None                                                                                        | SQL schema and authority changes                                                                                                                                 |

The built-in S3 adapter implements those reads using manifest and immutable-part
GETs; native GCS uses metadata GETs and generation-bound media range GETs. One
BodyStore call can make multiple HTTP requests. The upgrade invokes no external
`put`, `reserve`, `append`, `fence`, `seal`, `terminate`, `abort`, maintenance
list or delete. There is no external mutation opt-in because none is needed.
Custom modules are executable operator code and must uphold the read-only
contract.

Provision database capacity for the v12 imports, including transaction/WAL
space. That step currently retains imported external bytes in memory and reads
them sequentially; the configurable concurrency applies to prepare/v11
inspection. Physical import or later external garbage collection is a separate
operator procedure. Keep all writers stopped until the entire chain reaches v14.
