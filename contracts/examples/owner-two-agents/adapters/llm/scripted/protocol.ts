import type {
  LlmAdapterCallInput,
  LlmAdapterMessage,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
export function textOf(message: LlmAdapterMessage): string {
  return message.content.map((part) =>
    part.type === "text" && "text" in part
      ? part.text
      : part.type === "json" && "value" in part
      ? JSON.stringify(part.value)
      : ""
  ).join("\n");
}
function findField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) {
    const found = findField(child, key);
    if (found !== undefined) return found;
  }
}
function field(message: LlmAdapterMessage, key: string): unknown {
  for (const part of message.content) {
    if (part.type === "json" && "value" in part) {
      const found = findField(part.value, key);
      if (found !== undefined) return found;
    }
    if (part.type === "text" && "text" in part) {
      try {
        const found = findField(JSON.parse(part.text), key);
        if (found !== undefined) return found;
      } catch { /* prose is not a JSON result */ }
    }
  }
}
/** Pure request-to-result protocol, so retries never depend on a process counter. */
export function decide(input: LlmAdapterCallInput): LlmAdapterResult {
  const messages = input.request.messages;
  const recent = messages.filter((item) => item.role === "user").map(textOf)
    .reverse();
  const marker = recent.find((value) =>
    /(?:START|REVIEW|ENROLL)_DEMO runId=([a-zA-Z0-9-]+)/.test(value)
  );
  const match = marker?.match(
    /(START|REVIEW|ENROLL)_DEMO runId=([a-zA-Z0-9-]+)/,
  );
  if (!match) {
    throw new Error("Scripted demo request is missing its scenario marker.");
  }
  const [, phase, runId] = match;
  const answer = (content: string): LlmAdapterResult => ({
    content,
    attempts: [{ status: "completed" }],
    finishReason: "stop",
  });
  if (phase === "ENROLL") {
    return answer(`${input.model} is enrolled and ready.`);
  }
  const result = (step: string) =>
    messages.find((item) =>
      item.role === "tool" && item.toolCallId === `${runId}-${step}`
    );
  const call = (
    step: string,
    action: string,
    args: Record<string, string>,
  ): LlmAdapterResult => ({
    content: [],
    toolCalls: [{ id: `${runId}-${step}`, action, input: args }],
    attempts: [{ status: "completed" }],
    finishReason: "tool_calls",
  });
  for (const item of messages) {
    if (
      item.role === "tool" && item.toolCallId.startsWith(`${runId}-`) &&
      ["failed", "cancelled"].includes(String(field(item, "status")))
    ) {
      return answer(`The demo stopped because a tool failed: ${textOf(item)}`);
    }
  }
  if (input.model === "reviewer-script") {
    if (!result("review-clock")) {
      return call("review-clock", "get_current_time", {
        format: "iso",
        timezone: "UTC",
      });
    }
    if (!result("read")) return call("read", "readPlan", { runId });
    if (!result("review")) {
      const clock = field(result("review-clock")!, "iso");
      if (typeof clock !== "string") {
        throw new Error("The review clock did not return an ISO timestamp.");
      }
      return call("review", "reviewPlan", { runId, clock });
    }
    if (field(result("review")!, "status") !== "reviewed") {
      throw new Error("The owner did not confirm the reviewed plan.");
    }
    return answer(
      "Reviewed the saved draft. Added a rollback checkpoint and post-deploy verification.",
    );
  }
  if (input.model !== "coordinator-script") {
    throw new Error("Unknown scripted model.");
  }
  if (!result("clock")) {
    return call("clock", "get_current_time", {
      format: "iso",
      timezone: "UTC",
    });
  }
  if (!result("draft")) {
    const clock = field(result("clock")!, "iso");
    if (typeof clock !== "string") {
      throw new Error("The built-in clock did not return an ISO timestamp.");
    }
    return call("draft", "saveDraft", { runId, clock });
  }
  if (!result("ask")) {
    return call("ask", "ask", {
      target: "reviewer",
      message:
        `REVIEW_DEMO runId=${runId}. Read the saved plan, improve it, then report the review.`,
      mode: "public",
    });
  }
  if (!result("publish")) return call("publish", "publishPlan", { runId });
  if (field(result("publish")!, "status") !== "published") {
    throw new Error("The owner did not confirm publication.");
  }
  return answer(
    "Published the reviewed release plan. Both agents and all tools ran in the browser Worker; the owner stored the result.",
  );
}
