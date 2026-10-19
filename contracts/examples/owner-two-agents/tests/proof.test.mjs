import test from "node:test";
import assert from "node:assert/strict";
import {
  demoFiles,
  demoManifestMismatches,
} from "../scripts/package-proof.mjs";
import { fileURLToPath } from "node:url";
test("demo source proof excludes generated dependencies and detects changed, missing and added source", async () => {
  const files = await demoFiles(fileURLToPath(new URL("../", import.meta.url)));
  assert.ok(files["browser.ts"]);
  assert.ok(
    Object.keys(files).every((name) =>
      !/^(dist\/|node_modules\/|candidate\.tgz$|\.package-proof\.json$|package-lock\.json$)/
        .test(name)
    ),
  );
  const manifest = Object.fromEntries(
    Object.entries(files).map((
      [name, sha256],
    ) => [`contracts/examples/owner-two-agents/${name}`, { sha256 }]),
  );
  assert.deepEqual(demoManifestMismatches(files, manifest), []);
  manifest["contracts/examples/owner-two-agents/browser.ts"].sha256 = "changed";
  delete manifest["contracts/examples/owner-two-agents/owner.ts"];
  manifest["contracts/examples/owner-two-agents/obsolete.ts"] = {
    sha256: "missing",
  };
  assert.deepEqual(demoManifestMismatches(files, manifest), [
    "browser.ts",
    "obsolete.ts",
    "owner.ts",
  ]);
});
