/** Internal control flow for yielding a message route to deferred compaction. */
export class ContextCompactionDeferredError extends Error {
  constructor() {
    super("Context compaction is waiting for its checkpoint.");
    this.name = "ContextCompactionDeferredError";
  }
}
