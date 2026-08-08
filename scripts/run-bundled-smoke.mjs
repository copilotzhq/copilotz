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
