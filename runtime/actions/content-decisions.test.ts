import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { canonicalDecisions } from "./upgrade.ts";
import {
  contentDecisionTemplate,
  type ContentMigrationDecision,
  type ContentMigrationReport,
} from "./content-migration.ts";
import { digestContent } from "../content/digest.ts";

Deno.test("legacy ownership canonical bytes and fingerprints are unchanged; shared IDs are sorted and bound", async () => {
  const old =
    '[{"namespace":"space","assetId":"a","ownerId":"record"},{"namespace":"space","assetId":"z","ownerId":null}]';
  const decisions = [{ assetId: "z", ownerId: null, namespace: "space" }, {
    ownerId: "record",
    namespace: "space",
    assetId: "a",
  }];
  assertEquals(JSON.stringify(canonicalDecisions(decisions)), old);
  const hash = (value: unknown) =>
    digestContent(new TextEncoder().encode(JSON.stringify(value)));
  assertEquals(
    await hash(canonicalDecisions(decisions)),
    "sha256:0595bff0e9eb834010bdd76a97a35ec4a06c413ab322d1a91232628e493011db",
  );
  const shared = [{ namespace: "space", assetId: "a", ownerIds: ["z", "a"] }];
  const before = structuredClone(shared);
  assertEquals(canonicalDecisions(shared), [{
    namespace: "space",
    assetId: "a",
    ownerIds: ["a", "z"],
  }]);
  assertEquals(shared, before);
  assertNotEquals(
    await hash(canonicalDecisions(shared)),
    await hash(canonicalDecisions([{ ...shared[0], ownerIds: ["a"] }])),
  );
  for (
    const invalid of [
      {},
      { ownerId: null, ownerIds: ["a"] },
      { ownerIds: [] },
      { ownerIds: ["a", "a"] },
      { ownerIds: [1] },
      { ownerIds: null },
    ]
  ) {
    assertThrows(
      () =>
        canonicalDecisions([
          {
            namespace: "space",
            assetId: "a",
            ...invalid,
          } as ContentMigrationDecision,
        ]),
      TypeError,
    );
  }
});

Deno.test("content decision template is deterministic and CLI needs only a plan file", async () => {
  const asset = {
    namespace: "space",
    assetId: "a",
    state: null,
    origin: null,
    consumers: [],
    producers: [{ id: "z", type: "message" }, { id: "a", type: "message" }],
  };
  const ownership: ContentMigrationReport = {
    executionOwners: 1,
    executionEdges: 0,
    byProducer: {},
    removedNodes: 0,
    removedEdges: 0,
    assignedOwners: 0,
    assets: [
      { ...asset, classification: "ambiguous" },
      { ...asset, assetId: "orphan", producers: [], classification: "unowned" },
      ...(["owned", "producer", "missing"] as const).map((classification) => ({
        ...asset,
        assetId: classification,
        classification,
      })),
    ],
  };
  const expected = [
    { namespace: "space", assetId: "a", ownerIds: ["a", "z"] },
    { namespace: "space", assetId: "orphan", ownerId: null },
  ];
  assertEquals(contentDecisionTemplate({ ownership }), expected);
  assertEquals(
    contentDecisionTemplate({
      ownership: {
        ...ownership,
        assets: [...ownership.assets].reverse().map((a) => ({
          ...a,
          producers: [...a.producers].reverse(),
        })),
      },
    }),
    expected,
  );
  const directory = await Deno.makeTempDir({ prefix: "cutover-decisions-" });
  try {
    const path = `${directory}/review.json`;
    await Deno.writeTextFile(path, JSON.stringify({ ownership }));
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "scripts/upgrade-retained-data.ts",
        "content-decisions",
        `--plan=${path}`,
      ],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(
      new TextDecoder().decode(result.stdout),
      JSON.stringify(expected, null, 2) + "\n",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
