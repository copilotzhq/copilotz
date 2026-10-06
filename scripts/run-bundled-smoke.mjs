const module = await import(
  new URL("../dist/runtime-neutral-smoke.mjs", import.meta.url)
);
const result = await module.runRuntimeNeutralSmoke();
if (
  result?.assetText !== "portable" ||
  result?.providerEndpoint !== "https://runtime-smoke.invalid/v1/chat"
) {
  throw new Error(
    `Runtime smoke returned an invalid result: ${JSON.stringify(result)}`,
  );
}
console.log(JSON.stringify(result));

const skills = await import(
  new URL("../dist/skill-root-smoke.mjs", import.meta.url)
);
const skill = await skills.readPlanningSkill(
  new URL("../contracts/runtime/fixtures/skills/planning/", import.meta.url),
);
if (skill.body !== "Portable skill body." || !skill.readers) {
  throw new Error("Filesystem skill smoke failed.");
}
console.log(JSON.stringify(skill));
