/** Internal control flow for yielding a message route to operation-backed compaction. */
export class ContextCompactionAwaitingError extends Error {
  constructor() {
    super("Context compaction is waiting for its checkpoint.");
    this.name = "ContextCompactionAwaitingError";
  }
}
