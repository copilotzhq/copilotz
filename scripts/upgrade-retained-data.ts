import {
  type AuthorityUpgradeManifest,
  inspectAuthorityUpgrade,
} from "../runtime/authorization/upgrade.ts";
/** Explicit offline retained-data upgrade; never called by ordinary activation. */
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import { inspectRetainedDataDrain } from "../runtime/actions/drain.ts";
import {
  prepareRetainedDataUpgrade,
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
  !["drain", "prepare", "apply", "authority-inventory"].includes(command) ||
  args.some((arg) =>
    !["schema", "plan", "reviewed", "decisions", "authority"].some((name) =>
      arg.startsWith(`--${name}=`)
    )
  )
) {
  throw new Error(
    "Usage: COPILOTZ_MIGRATION_DATABASE_URL=... deno run -A scripts/upgrade-retained-data.ts drain|prepare|apply --schema=SCHEMA [--plan=FILE.json --reviewed=FINGERPRINT --decisions=FILE.json]",
  );
}
const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
if (!url) throw new Error("COPILOTZ_MIGRATION_DATABASE_URL is required.");
const database = await openManagedOminipgDatabase({ url });
try {
  if (command === "authority-inventory") {
    console.log(
      JSON.stringify(
        await inspectAuthorityUpgrade(database.session, schema),
        null,
        2,
      ),
    );
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
    const plan = await prepareRetainedDataUpgrade(database.session, schema);
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
    if (authority && !path) {
      await upgradeActionLifecycle(database.session, schema, { authority });
      console.log(JSON.stringify({ state: "complete", version: 12 }));
    } else {
      if (!path || !reviewedFingerprint) {
        throw new Error(
          "Finalization requires --plan=FILE.json and --reviewed=FINGERPRINT.",
        );
      }
      const plan = JSON.parse(
        await Deno.readTextFile(path),
      ) as RetainedDataUpgradePlan;
      const decisionsPath = get("decisions");
      const contentDecisions = decisionsPath
        ? JSON.parse(
          await Deno.readTextFile(decisionsPath),
        ) as ContentMigrationDecision[]
        : undefined;
      await upgradeActionLifecycle(database.session, schema, {
        plan,
        reviewedFingerprint,
        contentDecisions,
        authority,
      });
      console.log(JSON.stringify({ state: "complete", upgradeId: plan.id }));
    }
  }
} finally {
  await database.close();
}
