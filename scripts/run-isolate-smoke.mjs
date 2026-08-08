import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const path = process.argv[2];
const mode = process.argv[3] ?? "core";
if (!path) {
  throw new TypeError("Usage: run-isolate-smoke.mjs <bundle> [core|edge]");
}

const source = await readFile(path, "utf8");
const context = vm.createContext({
  AbortController,
  AbortSignal,
  ArrayBuffer,
  atob,
  Blob,
  btoa,
  clearInterval,
  clearTimeout,
  console,
  crypto: webcrypto,
  DOMException,
  fetch,
  FormData,
  Headers,
  queueMicrotask,
  ReadableStream,
  Request,
  Response,
  setInterval,
  setTimeout,
  structuredClone,
  TextDecoder,
  TextEncoder,
  TransformStream,
  Uint8Array,
  URL,
  URLSearchParams,
  WritableStream,
});
const module = new vm.SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Browser bundle retained external import '${specifier}'.`);
});
await module.evaluate();

let result;
if (mode === "edge") {
  const response = await module.namespace.default.fetch(
    new Request("https://runtime-smoke.invalid/"),
  );
  if (!response.ok) {
    throw new Error(`Edge smoke returned HTTP ${response.status}.`);
  }
  result = await response.json();
} else {
  result = await module.namespace.runRuntimeNeutralSmoke();
}

if (
  result?.assetText !== "portable" ||
  result?.providerEndpoint !== "https://runtime-smoke.invalid/v1/chat"
) {
  throw new Error(
    `Isolate smoke returned an invalid result: ${JSON.stringify(result)}`,
  );
}
console.log(JSON.stringify(result));
