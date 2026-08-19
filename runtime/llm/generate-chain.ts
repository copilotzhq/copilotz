import type { ScopedPluginResources } from "../engine/index.ts";
import {
  isCrossResourceFailover,
} from "./errors.ts";
import {
  invocationFromChat,
  type LlmFrame,
  type LlmGenerate,
  type LlmGenerateInput,
  type LlmInvocation,
  type LlmSession,
  type LlmSessionInput,
  requireLlmGenerate,
  requireLlmResource,
  requireLlmSession,
} from "./provider-resource.ts";
import type {
  LLMUsageAttempt,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderName,
} from "./types.ts";

export type GenerateChainTarget = {
  config: ProviderConfig;
  generate: LlmGenerate;
};

export type SessionChainTarget = {
  config: ProviderConfig;
  session: LlmSession;
};

export function isSameResourceFallback(
  primary: ProviderName,
  fallback: ProviderFallbackConfig,
): boolean {
  return !fallback.provider || fallback.provider === primary;
}

/**
 * Consecutive same-id fallbacks stay one generate(). A different id starts
 * the next chain target. List order is preserved.
 */
export function generateTargetsFromConfig(
  config: ProviderConfig,
): ProviderConfig[] {
  const primary = config.provider;
  if (!primary) {
    throw new Error("No LLM provider configured for generate chain");
  }

  type Entry = {
    provider: ProviderName;
    override?: ProviderFallbackConfig;
  };

  const entries: Entry[] = [
    { provider: primary },
    ...(config.fallbacks ?? []).map((fallback) => ({
      provider: fallback.provider ?? primary,
      override: fallback,
    })),
  ];

  const groups: Entry[][] = [];
  for (const entry of entries) {
    const current = groups.at(-1);
    if (current && current[0].provider === entry.provider) {
      current.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  return groups.map((group) => {
    const [head, ...tail] = group;
    const changesProvider = head.provider !== primary;
    const override = head.override;
    const fallbacks = tail
      .map((entry) => entry.override)
      .filter((value): value is ProviderFallbackConfig => value !== undefined);
    return {
      ...config,
      ...(override ?? {}),
      provider: head.provider,
      ...(changesProvider && !override?.apiKey ? { apiKey: undefined } : {}),
      ...(changesProvider && !override?.runtimeDiagnostics
        ? { runtimeDiagnostics: undefined }
        : {}),
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
    } as ProviderConfig;
  });
}

export function generateChainFromResources(
  resources: ScopedPluginResources,
  config: ProviderConfig,
): GenerateChainTarget[] {
  return generateTargetsFromConfig(config).map((target) => ({
    config: target,
    generate: (input) =>
      requireLlmGenerate(
        requireLlmResource(resources, String(target.provider)),
      )(input),
  }));
}

/**
 * Shared text/memory loop. Continues only on LLMCrossResourceFailover.
 * `finalize_partial` returns a response and stops. Other throws stop.
 */
export function runGenerateChain(
  targets: readonly GenerateChainTarget[],
  input: Omit<LlmGenerateInput, "config" | "hasExternalFallback">,
): LlmInvocation {
  if (targets.length === 0) {
    return invocationFromChat(
      Promise.reject(new Error("LLM generate chain has no targets")),
    );
  }

  let cancelCurrent = (_reason?: unknown): void => undefined;
  const result = (async () => {
    let priorUsage: LLMUsageAttempt[] = [];
    let lastError: unknown;
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      const invocation = target.generate({
        ...input,
        config: target.config,
        hasExternalFallback: index < targets.length - 1,
      });
      cancelCurrent = (reason) => invocation.cancel(reason);
      try {
        const response = await invocation.result;
        if (priorUsage.length === 0) return response;
        return {
          ...response,
          usageAttempts: [...priorUsage, ...(response.usageAttempts ?? [])],
        };
      } catch (error) {
        if (!isCrossResourceFailover(error)) throw error;
        priorUsage = [...priorUsage, ...error.usageAttempts];
        lastError = error;
      }
    }
    throw lastError ?? new Error("LLM generate chain exhausted all targets");
  })();

  return invocationFromChat(result, (reason) => cancelCurrent(reason));
}

export function sessionChainFromResources(
  resources: ScopedPluginResources,
  config: ProviderConfig,
): SessionChainTarget[] {
  return generateTargetsFromConfig(config).map((target) => ({
    config: target,
    session: (input) =>
      requireLlmSession(
        requireLlmResource(resources, String(target.provider)),
      )(input),
  }));
}

/**
 * Same-mode session failover. Continues only on LLMCrossResourceFailover.
 * Frames belong to the current adapter invocation.
 */
export function runSessionChain(
  targets: readonly SessionChainTarget[],
  input: Omit<LlmSessionInput, "config" | "hasExternalFallback">,
): LlmInvocation {
  if (targets.length === 0) {
    return invocationFromChat(
      Promise.reject(new Error("LLM session chain has no targets")),
    );
  }
  if (targets.length === 1) {
    return targets[0]!.session({
      ...input,
      config: targets[0]!.config,
      hasExternalFallback: false,
    });
  }

  let cancelCurrent = (_reason?: unknown): void => undefined;
  let forward: ReadableStreamDefaultController<LlmFrame> | undefined;
  const frames = new ReadableStream<LlmFrame>({
    start(controller) {
      forward = controller;
    },
    cancel(reason) {
      cancelCurrent(reason);
    },
  });
  const result = (async () => {
    let priorUsage: LLMUsageAttempt[] = [];
    let lastError: unknown;
    try {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]!;
        const invocation = target.session({
          ...input,
          config: target.config,
          hasExternalFallback: index < targets.length - 1,
        });
        cancelCurrent = (reason) => invocation.cancel(reason);
        const reader = invocation.frames.getReader();
        const pumping = (async () => {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            forward?.enqueue(next.value);
          }
        })();
        try {
          const response = await invocation.result;
          await pumping;
          if (priorUsage.length === 0) return response;
          return {
            ...response,
            usageAttempts: [...priorUsage, ...(response.usageAttempts ?? [])],
          };
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          if (!isCrossResourceFailover(error)) throw error;
          priorUsage = [...priorUsage, ...error.usageAttempts];
          lastError = error;
        }
      }
      throw lastError ?? new Error("LLM session chain exhausted all targets");
    } finally {
      try {
        forward?.close();
      } catch {
        // Consumer already cancelled.
      }
    }
  })();
  return Object.freeze({
    frames,
    result,
    cancel(reason) {
      cancelCurrent(reason);
    },
  });
}
