/** Submits already accepted Channel occurrences through an application. @module */

import type {
  ApplicationSendHandle,
  ApplicationSendInput,
} from "@copilotz/copilotz/application";
import { channelIngress } from "../channel-ingress/index.ts";
import type { ChannelIngressOccurrence } from "../../shared/contracts.ts";

/** The smallest application capability required by submitChannel. */
export type ChannelSendApplication = Readonly<{
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
}>;

/** Trusted scope and opaque operation claims attached to submitted envelopes. */
export type SubmitChannelOptions = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  operationMetadata?: Readonly<Record<string, unknown>>;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Builds every durable ingress envelope before sending the first occurrence,
 * then submits them in order with cancellation on partial failure.
 */
export async function submitChannel(
  application: ChannelSendApplication,
  channelId: string,
  occurrences: readonly ChannelIngressOccurrence[],
  options: SubmitChannelOptions = {},
): Promise<readonly ApplicationSendHandle[]> {
  const operationMetadata = record(options.operationMetadata);
  const envelopes: ApplicationSendInput[] = [];
  for (let index = 0; index < occurrences.length; index += 1) {
    const envelope = channelIngress(channelId, occurrences[index], {
      ...(options.namespace !== undefined
        ? { namespace: options.namespace }
        : {}),
      ...(options.databaseSchema !== undefined
        ? { databaseSchema: options.databaseSchema }
        : {}),
    });
    envelopes.push({
      ...envelope,
      ...(Object.keys(operationMetadata).length
        ? { operationMetadata: structuredClone(operationMetadata) }
        : {}),
    });
  }

  const handles: ApplicationSendHandle[] = [];
  try {
    for (const envelope of envelopes) {
      const handle = await application.send(envelope);
      handles.push(handle);
      // Detached callers still need a rejection observer while settlement is
      // in flight. The original Promise remains available to the caller.
      void handle.done.catch(() => undefined);
    }
  } catch (error) {
    await Promise.allSettled(
      handles.map((handle) =>
        Promise.resolve().then(() => handle.cancel("channel_accept_failed"))
      ),
    );
    throw error;
  }
  return handles;
}
