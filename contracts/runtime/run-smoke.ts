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
