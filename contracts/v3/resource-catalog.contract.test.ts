import { assert, assertEquals } from "@std/assert";

import { loadResources } from "@/index.ts";
import { bundledResourcesUrl, manifest } from "@/resources/index.ts";

function resourceIdentity(
  category: string,
  value: unknown,
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (category === "tools") {
    return typeof record.id === "string"
      ? record.id
      : typeof record.key === "string"
      ? record.key
      : undefined;
  }
  return typeof record.id === "string"
    ? record.id
    : typeof record.name === "string"
    ? record.name
    : undefined;
}

Deno.test("A04 every declared built-in resource is loadable with stable identity", async () => {
  const categories = Object.keys(manifest.provides);
  const loaded = await loadResources({
    path: bundledResourcesUrl,
    imports: categories,
  }) as unknown as Record<string, unknown>;

  for (const [category, expectedNames] of Object.entries(manifest.provides)) {
    const resources = loaded[category];
    assert(Array.isArray(resources), `${category} did not load as an array`);
    assertEquals(
      resources.length,
      expectedNames.length,
      `${category} manifest/load count mismatch`,
    );
    assertEquals(
      new Set(expectedNames).size,
      expectedNames.length,
      `${category} manifest contains duplicate selectors`,
    );

    if (category === "processors") {
      const composites = resources.map((resource) => {
        const record = resource as Record<string, unknown>;
        assert(
          typeof record.id === "string" && record.id.length > 0,
          `processor ${String(record.eventType)} has no stable id`,
        );
        assert(
          typeof record.eventType === "string" && record.eventType.length > 0,
          `processor ${String(record.id)} has no event type`,
        );
        return `${record.id}:${record.eventType}`;
      });
      assertEquals(
        new Set(composites).size,
        composites.length,
        "processor id/event pairs must be unique",
      );
      const loadedEventTypes = resources.map((resource) =>
        String((resource as Record<string, unknown>).eventType)
      ).sort();
      const expectedEventTypes = expectedNames.map((name) =>
        name.slice(name.lastIndexOf("/") + 1)
      ).sort();
      assertEquals(loadedEventTypes, expectedEventTypes);
      continue;
    }

    const identities = resources.map((resource) =>
      resourceIdentity(category, resource)
    );
    const stableIdentities = identities.filter(
      (identity): identity is string =>
        typeof identity === "string" && identity.length > 0,
    );
    assert(
      stableIdentities.length === identities.length,
      `${category} contains a resource without stable identity`,
    );
    assertEquals(new Set(stableIdentities).size, stableIdentities.length);
    assertEquals([...stableIdentities].sort(), [...expectedNames].sort());
  }
});

Deno.test("A04 every built-in preset references declared resources", () => {
  const provides = manifest.provides as Record<string, readonly string[]>;

  for (const [preset, selectors] of Object.entries(manifest.presets)) {
    for (const selector of selectors) {
      const separator = selector.indexOf(".");
      if (separator === -1) {
        assert(
          selector in provides,
          `${preset} references unknown resource category ${selector}`,
        );
        continue;
      }

      const category = selector.slice(0, separator);
      const name = selector.slice(separator + 1);
      assert(
        provides[category]?.includes(name),
        `${preset} references undeclared resource ${selector}`,
      );
    }
  }
});
