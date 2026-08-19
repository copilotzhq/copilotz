import type {
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFactory,
  ProviderName,
  StreamCallback,
} from "./types.ts";
import type { ScopedPluginResources } from "../engine/index.ts";
import { chat } from "./orchestrator.ts";

/** Protocol values from one adapter invocation. Not Copilotz events. */
export type LlmFrame = Readonly<{
  type: string;
  payload?: unknown;
}>;

export type LlmResult = ChatResponse;

export type LlmInvocation = Readonly<{
  frames: ReadableStream<LlmFrame>;
  result: Promise<LlmResult>;
  cancel(reason?: unknown): void;
}>;

export type LlmGenerateInput = Readonly<{
  request: ChatRequest;
  config: ProviderConfig;
  env?: Record<string, string>;
  stream?: StreamCallback;
  /** A later `runGenerateChain` target exists after this resource. */
  hasExternalFallback?: boolean;
}>;

export type LlmSessionInput =
  & LlmGenerateInput
  & Readonly<{
    /** Ongoing user/audio ingress. Bytes, not Copilotz events. */
    input?: ReadableStream<Uint8Array>;
  }>;

export type LlmGenerate = (input: LlmGenerateInput) => LlmInvocation;
export type LlmSession = (input: LlmSessionInput) => LlmInvocation;

/** One vendor adapter. Not an orchestrator and not a policy bag. */
export type LlmResource = Readonly<{
  id: string;
  type: "llm";
  generate?: LlmGenerate;
  session?: LlmSession;
}>;

/** @deprecated Use LlmResource. */
export type LlmProviderResource = LlmResource;

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function invocationFromChat(
  result: Promise<ChatResponse>,
  cancel: (reason?: unknown) => void = () => undefined,
): LlmInvocation {
  return Object.freeze({
    frames: new ReadableStream<LlmFrame>({ start(controller) {
      controller.close();
    } }),
    result,
    cancel,
  });
}

export function generateFromChat(
  chatFn: (
    request: ChatRequest,
    config: ProviderConfig,
    env?: Record<string, string>,
    stream?: StreamCallback,
  ) => Promise<ChatResponse>,
): LlmGenerate {
  return (input) =>
    invocationFromChat(
      chatFn(input.request, input.config, input.env, input.stream),
    );
}

/** Bind one ProviderFactory as an llm resource generate() implementation. */
export function generateFromFactory(
  id: string,
  factory: ProviderFactory,
): LlmGenerate {
  return (input) =>
    invocationFromChat(
      chat(
        input.request,
        { ...input.config, provider: id as ProviderName },
        input.env ?? {},
        input.stream,
        { [id]: factory },
        { hasExternalFallback: input.hasExternalFallback === true },
      ),
    );
}

export function sessionFromHandler(
  handler: (
    input: LlmSessionInput,
    emit: (frame: LlmFrame) => void,
  ) => Promise<LlmResult>,
): LlmSession {
  return (input) => {
    const abort = new AbortController();
    const requestSignal = input.request.signal;
    const onAbort = () => {
      if (!abort.signal.aborted) abort.abort(requestSignal?.reason);
    };
    requestSignal?.addEventListener("abort", onAbort, { once: true });
    let closed = false;
    let controller: ReadableStreamDefaultController<LlmFrame> | undefined;
    const pending: LlmFrame[] = [];
    const frames = new ReadableStream<LlmFrame>({
      start(started) {
        controller = started;
        for (const frame of pending) started.enqueue(frame);
        pending.length = 0;
        if (closed) {
          try {
            started.close();
          } catch {
            // Consumer already cancelled.
          }
        }
      },
      cancel(reason) {
        if (!abort.signal.aborted) abort.abort(reason);
      },
    });
    const emit = (frame: LlmFrame): void => {
      if (closed) return;
      if (controller) controller.enqueue(frame);
      else pending.push(frame);
    };
    const result = (async () => {
      try {
        return await handler({
          ...input,
          request: { ...input.request, signal: abort.signal },
        }, emit);
      } finally {
        requestSignal?.removeEventListener("abort", onAbort);
        if (!closed) {
          closed = true;
          try {
            controller?.close();
          } catch {
            // Consumer already cancelled.
          }
        }
      }
    })();
    return Object.freeze({
      frames,
      result,
      cancel(reason) {
        if (!abort.signal.aborted) abort.abort(reason);
      },
    });
  };
}

export function defineLlmProviderResource(
  resource: LlmResource,
): LlmResource {
  const id = requiredText(resource.id, "LLM provider resource id");
  if (resource.type !== "llm") {
    throw new TypeError(`Provider '${id}' must have type 'llm'.`);
  }
  if (
    typeof resource.generate !== "function" &&
    typeof resource.session !== "function"
  ) {
    throw new TypeError(
      `Provider '${id}' requires generate or session.`,
    );
  }
  return Object.freeze({
    id,
    type: "llm",
    ...(resource.generate ? { generate: resource.generate } : {}),
    ...(resource.session ? { session: resource.session } : {}),
  });
}

export function isLlmProviderResource(
  value: unknown,
): value is LlmResource {
  const candidate = record(value);
  return typeof candidate.id === "string" && candidate.type === "llm" &&
    (
      typeof candidate.generate === "function" ||
      typeof candidate.session === "function"
    );
}

export function isLlmResource(value: unknown): value is LlmResource {
  return isLlmProviderResource(value);
}

export function requireLlmGenerate(resource: LlmResource): LlmGenerate {
  if (typeof resource.generate !== "function") {
    throw new Error(
      `LLM resource '${resource.id}' does not implement generate().`,
    );
  }
  return resource.generate;
}

export function requireLlmSession(resource: LlmResource): LlmSession {
  if (typeof resource.session !== "function") {
    throw new Error(
      `LLM resource '${resource.id}' does not implement session().`,
    );
  }
  return resource.session;
}

export function requireLlmResource(
  resources: ScopedPluginResources,
  id: string,
): LlmResource {
  const resource = resources.get("llm", id);
  if (isLlmResource(resource)) return resource;
  throw new Error(`LLM resource '${id}' is not registered.`);
}
