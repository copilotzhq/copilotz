import { runRuntimeNeutralSmoke } from "./runtime-neutral-smoke.ts";

const result = await runRuntimeNeutralSmoke();
if (
  result.assetText !== "portable" ||
  result.providerEndpoint !== "https://runtime-smoke.invalid/v1/chat"
) {
  throw new Error(
    `Runtime smoke returned an invalid result: ${JSON.stringify(result)}`,
  );
}
console.log(JSON.stringify(result));

const { readPlanningSkill } = await import("./skill-root-smoke.ts");
const skill = await readPlanningSkill(
  new URL("./fixtures/skills/planning/", import.meta.url),
);
if (skill.body !== "Portable skill body." || !skill.readers) {
  throw new Error("Filesystem skill smoke failed.");
}
console.log(JSON.stringify(skill));
