# Local PostgreSQL owner COMMIT fault tests

`runtime/owner/boundary.postgres.test.ts` is an opt-in, destructive fixture for
a disposable local PostgreSQL database. Its helpers live in `runtime/testing/`
and are not production runtime modules. No external service or production
database is needed.

## Requirements

- Deno and a local PostgreSQL installation from a trusted official source. The
  fixture was exercised with Deno 2.9.2 and PostgreSQL 17.11
- An agent-owned disposable cluster listening only on loopback, with plaintext
  local connections. The fixture rejects non-loopback URLs and TLS connections
- A local test role that can create/drop schemas, inspect its own backend and
  lock state, and terminate its own test backends. Do not grant extra privileges
  to a production role to run this fixture
- Enough free disk for the cluster and WAL. Keep at least 2 GB free and stop the
  run if free space drops below that level

Use bounded cluster settings, for example `shared_buffers=32MB`,
`max_wal_size=64MB`, `min_wal_size=32MB`, and `max_connections=16`. Keep
`fsync=on` and `synchronous_commit=on`; turning off durability defeats the
test's purpose. Use `listen_addresses=127.0.0.1` and, when Unix sockets are
unavailable, `unix_socket_directories=''`. No system service, persistent
credentials, or system/network permission changes are necessary.

Start and stop the disposable server using your local PostgreSQL tools in the
same shell or job. Set `COPILOTZ_TEST_POSTGRES_URL` explicitly to that cluster's
loopback database URL with `sslmode=disable`. The fixture never reads
`DATABASE_URL` and never creates a cluster automatically.

## Five scenarios

1. **Savepoint prerequisite:** `SAVEPOINT`, `ROLLBACK TO SAVEPOINT`, and
   `RELEASE SAVEPOINT` retain the same backend PID and transaction ID
2. **Connection loss, committed outcome:** the client connection is severed
   while the server is executing COMMIT; the server later commits
3. **Connection loss, aborted outcome:** the client connection is severed and
   the still-blocked COMMIT backend is terminated, causing an abort
4. **Owner process death, committed outcome:** the actual owner subprocess is
   killed with SIGKILL during COMMIT; the server later commits
5. **Owner process death, aborted outcome:** the owner subprocess is killed and
   the still-blocked COMMIT backend is terminated

Each fault case contains an existing compatible duplicate, a conflicting
duplicate, a new successful Collection command, and a command that throws after
real writes. The failed command's savepoint must roll back its data, event,
receipt, alarm and sequence effects without losing the successful sibling.

A schema-local deferred constraint trigger pauses the backend **inside COMMIT**
on an advisory lock. A frame-aware TCP proxy proves that the actual COMMIT was
forwarded before breaking the client path. The proxy deliberately retains its
server socket after client loss or process death, modeling a broken client/reply
path with an unresolved server transaction. This is not a synthetic exception
injected after a known commit, a PostgreSQL server crash, or a host power loss.

The successor's owner acquisition must wait behind that exact old backend and
transaction ID. PostgreSQL may block the initial `INSERT ... ON CONFLICT` probe
before reaching the epoch-CAS `UPDATE`; either acquisition statement is accepted
only with matching `pg_blocking_pids` and an ungranted transaction-ID lock.
Owner state, visible data and outputs stay unchanged until the old outcome
resolves, then the expected-epoch CAS advances the successor to epoch 2.

Assertions cover atomic Collection data, receipts, alarms, event bodies,
deliveries and gap-free event sequence numbers; no pre-durability results or
publication; stopped/dead old holders; stale mutation rejection; and
receipt-decided replay of compatible and conflicting duplicates. Dispatch uses a
test output sink. Full host readiness/reconciliation, real Processor recovery,
and published-package readiness need their separate evidence.

## Dependency prerequisite and source mapping

The published Ominipg 0.9.1 adapter misclassifies `ROLLBACK TO SAVEPOINT` as a
full transaction ending and releases its pinned lane. Consequently the first
test fails at `RELEASE SAVEPOINT`; do not bypass that prerequisite or remove
mixed failed commands to make the remaining cases pass.

The five-case passing evidence uses the narrowly scoped transaction-control fix
in an explicitly selected
[Ominipg source checkout](https://github.com/AxionCompany/ominipg). It is
source-mapped adapter evidence, not a claim that the published 0.9.1 pin passes.
No Copilotz dependency pin needs to change for this investigation.

From the Copilotz repository root, select the reviewed Ominipg checkout in
`OMINIPG_SOURCE`. Generate a temporary Deno configuration outside both
repositories. This example preserves Copilotz imports and scopes Ominipg's own
dependency pins to its source directory:

```sh
export OMINIPG_SOURCE=../ominipg
export COPILOTZ_TEST_DENO_CONFIG="$(mktemp)"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(process.cwd() + sep);
const source = pathToFileURL(resolve(process.env.OMINIPG_SOURCE) + sep);
const config = JSON.parse(readFileSync(new URL('deno.json', root), 'utf8'));
const dependency = JSON.parse(readFileSync(new URL('deno.json', source), 'utf8'));
if (dependency.name !== '@oxian/ominipg') throw new Error('Wrong source checkout');
const absolute = (imports, base) => Object.fromEntries(
  Object.entries(imports ?? {}).map(([key, value]) =>
    [key, value.startsWith('.') ? new URL(value, base).href : value]));
const imports = absolute(config.imports, root);
for (const [key, value] of Object.entries(dependency.exports)) {
  imports['@oxian/ominipg' + (key === '.' ? '' : key.slice(1))] =
    new URL(value, source).href;
}
writeFileSync(process.env.COPILOTZ_TEST_DENO_CONFIG, JSON.stringify({
  unstable: config.unstable,
  imports,
  scopes: { [source.href]: absolute(dependency.imports, source) },
  lock: false,
}, null, 2));
JS
env -u DATABASE_URL deno test --allow-all \
  --config "$COPILOTZ_TEST_DENO_CONFIG" \
  runtime/owner/boundary.postgres.test.ts
status=$?
rm -f "$COPILOTZ_TEST_DENO_CONFIG"
unset COPILOTZ_TEST_DENO_CONFIG OMINIPG_SOURCE
# Preserve "$status" as the job's test exit status after stopping the cluster.
```

The exported configuration variable is essential: the actual owner subprocess
must use the same dependency source map as the parent test. Record the selected
checkout's commit/tree and dirty state with the results. After a compatible
adapter release is independently verified, the normal repository configuration
can be tested without the source-map override.

Without `COPILOTZ_TEST_POSTGRES_URL`, all five tests explicitly skip. A skipped
run is not PostgreSQL conformance evidence. Run this batch serially without
other heavy suites and preserve its complete terminal summary and exit code. The
bounded witnesses retain their ten-second deadlines.

## Cleanup

The tests close child processes and proxy connections, release their advisory
gate, close database sessions, and drop their random `owner_commit_*` schemas in
`finally` blocks. Your job remains responsible for stopping the local PostgreSQL
cluster and removing its disposable data directory and temporary source-map
file. Use a shell/job cleanup trap for interruption; an uncatchable kill can
leave those temporary resources behind. Check that no test backend/server
remains running before reusing the port or removing the cluster directory.
