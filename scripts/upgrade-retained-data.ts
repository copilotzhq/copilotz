import { listMissingContent } from "../runtime/content/migration.ts";
import type { UnrecoverableDecisions } from "../runtime/content/unrecoverable.ts";
import type { AbandonmentDecisions } from "../runtime/actions/upgrade-terminals.ts";
import { loadUpgradeStorage } from "./upgrade-storage.ts";
import { resolve, toFileUrl } from "@std/path";
import { EVENT_SCHEMA_VERSION } from "../runtime/events/schema.ts";
import {
  type AuthorityUpgradeManifest,
  iterateAuthorityUpgrade,
} from "../runtime/authorization/upgrade.ts";
/** Explicit offline retained-data upgrade; never called by ordinary activation. */
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import { inspectRetainedDataDrain } from "../runtime/actions/drain.ts";
import {
  type OwnerKeyUpgradeOptions,
  prepareRetainedDataUpgrade,
  retainedContentInspector,
  type RetainedDataUpgradePlan,
  upgradeActionLifecycle,
} from "../runtime/actions/upgrade.ts";
import type { ContentMigrationDecision } from "../runtime/actions/content-migration.ts";

const [command, ...args] = Deno.args;
const get = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const schema = get("schema");
if (
  !schema ||
  !["drain", "prepare", "apply", "authority-inventory", "list-missing-content"]
    .includes(command) ||
  args.some((arg) =>
    ![
      "schema",
      "plan",
      "reviewed",
      "decisions",
      "abandoned",
      "unrecoverable",
      "authority",
      "owner-keys",
      "storage",
      "concurrency",
    ]
      .some((name) => arg.startsWith(`--${name}=`))
  )
) {
  throw new Error(
    "Usage: COPILOTZ_MIGRATION_DATABASE_URL=... deno run -A scripts/upgrade-retained-data.ts drain|prepare|apply|authority-inventory|list-missing-content --schema=SCHEMA [--plan=FILE.json --reviewed=FINGERPRINT --decisions=FILE.json --abandoned=FILE.json --unrecoverable=FILE.json --owner-keys=MODULE.ts --storage=MODULE.ts --concurrency=16 --authority=FILE.json]",
  );
}
const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
if (!url) throw new Error("COPILOTZ_MIGRATION_DATABASE_URL is required.");
const storagePath = get("storage");
const storage = storagePath ? await loadUpgradeStorage(storagePath) : {};
const concurrency = get("concurrency");
const abandonedPath = get("abandoned");
const abandoned = abandonedPath
  ? JSON.parse(await Deno.readTextFile(abandonedPath)) as AbandonmentDecisions
  : undefined;
const contentStorage = {
  abandoned,
  unrecoverable: get("unrecoverable")
    ? JSON.parse(
      await Deno.readTextFile(get("unrecoverable")!),
    ) as UnrecoverableDecisions
    : undefined,
  ...storage,
  ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
};
if (
  contentStorage.concurrency !== undefined &&
  (!Number.isSafeInteger(contentStorage.concurrency) ||
    contentStorage.concurrency < 1 || contentStorage.concurrency > 256)
) {
  throw new TypeError("--concurrency must be an integer from 1 to 256.");
}
const database = await openManagedOminipgDatabase({
  url,
  statementTimeoutMs: null,
  requestTimeoutMs: 24 * 60 * 60 * 1000,
});
try {
  if (command === "list-missing-content") {
    console.log(
      JSON.stringify(
        await listMissingContent(
          retainedContentInspector(database.session, schema, contentStorage),
        ),
        null,
        2,
      ),
    );
  } else if (command === "authority-inventory") {
    const encoder = new TextEncoder();
    const write = async (text: string) => {
      const bytes = encoder.encode(text);
      let offset = 0;
      while (offset < bytes.length) {
        offset += await Deno.stdout.write(bytes.subarray(offset));
      }
    };
    const events = [];
    let count = 0;
    await write('{"invocations":[');
    for await (
      const batch of iterateAuthorityUpgrade(database.session, schema)
    ) {
      for (const invocation of batch.invocations) {
        await write((count++ ? "," : "") + JSON.stringify(invocation));
      }
      events.push(...batch.events);
    }
    await write('],"events":' + JSON.stringify(events) + "}\n");
  } else if (command === "drain") {
    const report = await inspectRetainedDataDrain(database.session, schema);
    console.log(JSON.stringify(report, null, 2));
    if (!report.drained) Deno.exitCode = 2;
  } else if (command === "prepare") {
    const path = get("plan");
    if (!path) {
      throw new Error(
        "Preparation requires --plan=FILE.json to retain the review inventory.",
      );
    }
    const plan = await prepareRetainedDataUpgrade(
      database.session,
      schema,
      contentStorage,
    );
    if (plan) {
      await Deno.writeTextFile(path, JSON.stringify(plan, null, 2) + "\n", {
        createNew: true,
      });
      console.log(
        JSON.stringify({
          state: "prepared",
          fingerprint: plan.fingerprint,
          plan: path,
          bodies: plan.content.inventory.length,
          ownership: plan.ownership,
        }),
      );
    } else console.log(JSON.stringify({ state: "complete" }));
  } else {
    const path = get("plan"), reviewedFingerprint = get("reviewed");
    const authorityPath = get("authority");
    const authority = authorityPath
      ? JSON.parse(
        await Deno.readTextFile(authorityPath),
      ) as AuthorityUpgradeManifest
      : undefined;
    const keysPath = get("owner-keys");
    const ownerKeys = keysPath
      ? (await import(toFileUrl(resolve(keysPath)).href))
        .default as OwnerKeyUpgradeOptions
      : undefined;
    if (keysPath && (!ownerKeys?.sourceAdapter || !ownerKeys?.masterAdapter)) {
      throw new TypeError(
        "--owner-keys module must default-export sourceAdapter and masterAdapter.",
      );
    }
    const plan = path
      ? JSON.parse(await Deno.readTextFile(path)) as RetainedDataUpgradePlan
      : undefined;
    const decisionsPath = get("decisions");
    const contentDecisions = decisionsPath
      ? JSON.parse(
        await Deno.readTextFile(decisionsPath),
      ) as ContentMigrationDecision[]
      : undefined;
    await upgradeActionLifecycle(database.session, schema, {
      ...contentStorage,
      plan,
      reviewedFingerprint,
      contentDecisions,
      ownerKeys,
      authority,
    });
    console.log(
      JSON.stringify({
        state: "complete",
        version: EVENT_SCHEMA_VERSION,
        upgradeId: plan?.id,
      }),
    );
  }
} finally {
  await database.close();
}
