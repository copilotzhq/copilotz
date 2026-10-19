/** Execution placement assertion, never an emulated browser environment. */
export function assertBrowserWorker(): void {
  if (
    typeof globalThis.WorkerGlobalScope === "undefined" ||
    !(globalThis instanceof globalThis.WorkerGlobalScope) ||
    "document" in globalThis || "process" in globalThis || "Deno" in globalThis
  ) {
    throw new Error(
      "Demo Action, Processor and model code must execute in a browser Worker.",
    );
  }
}
