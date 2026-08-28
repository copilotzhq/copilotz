/**
 * Shared data contracts for the channel core and provider plugins.
 *
 * @module
 */

import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import type {
  ContentInput,
  ContentSequence,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import type { CopilotzPlugin } from "@copilotz/copilotz/plugins";
import type { channelsPlugin } from "../plugin.ts";

export type ChannelJsonPrimitive = string | number | boolean | null;
export type ChannelJsonValue =
  | ChannelJsonPrimitive
  | readonly ChannelJsonValue[]
  | Readonly<{ [key: string]: ChannelJsonValue }>;
export type ChannelJsonObject = Readonly<{
  [key: string]: ChannelJsonValue;
}>;

/** Data-only composition policy. Its resource-map alias is its sole identity. */
export type ChannelResource = Readonly<{
  egress: "external" | "request-observation";
  /** Aliases in resources.agents, resolved only by the ingress Action. */
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;

/** Raw host request. It is transient and is never accepted as Action input. */
export type ChannelRequest = Readonly<{
  method: string;
  headers: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: unknown;
  rawBody?: Uint8Array;
  context?: Readonly<Record<string, unknown>>;
}>;

/** The sole durable result of accepting one provider occurrence. */
export type ChannelIngressOccurrence = Readonly<{
  id: string;
  input: ChannelJsonValue;
}>;

export type ChannelAcceptResult = Readonly<{
  occurrences: readonly ChannelIngressOccurrence[];
  status?: number;
  response?: unknown;
}>;

export type ChannelAcceptContext = Readonly<{
  namespace: string;
  channelId: string;
  channel: ChannelResource;
  signal: AbortSignal;
  now(): Date;
}>;

export type ChannelParticipantType = "human" | "agent" | "tool" | "job";

/** Transient participant description returned by Adapter.receive. */
export type ChannelParticipantInput = Readonly<{
  id?: string;
  externalId: string;
  participantType: ChannelParticipantType;
  name?: string;
  email?: string;
  agentId?: string;
  metadata?: ChannelJsonObject;
}>;

export type ChannelParticipantRef = string | ChannelParticipantInput;

/** Transient Core thread fields returned by Adapter.receive. */
export type ChannelThreadInput = Readonly<{
  name?: string;
  description?: string;
  status?: string;
  metadata?: ChannelJsonObject;
  /** Durable thread members, independent of this message's recipients. */
  participants?: readonly ChannelParticipantRef[];
}>;

/** Provider-relative policy lowered to Core participant IDs by the Action. */
export type ChannelMessageVisibility = "public" | "participants" | "internal";

/**
 * Semantic provider message produced inside the worker. Bytes may exist here;
 * they have not crossed a durable Event or Action boundary.
 */
export type ChannelReceivedMessage = Readonly<{
  externalThreadId: string;
  sender: ChannelParticipantInput;
  recipients?: readonly ChannelParticipantRef[];
  content: ContentInput | readonly ContentInput[];
  thread?: ChannelThreadInput;
  /** Non-secret provider coordinates required by detached egress. */
  route?: ChannelJsonObject;
  metadata?: ChannelJsonObject;
  /** Defaults to participant-scoped visibility when omitted. */
  visibility?: ChannelMessageVisibility;
}>;

export type ChannelReceiveContext = Readonly<{
  namespace: string;
  channelId: string;
  channel: ChannelResource;
  occurrenceId: string;
  signal: AbortSignal;
  now(): Date;
}>;

export type ChannelBindingRecord = Readonly<{
  id: string;
  namespace: string;
  /** Alias in resources.channels and adapters.channels. */
  channelId: string;
  externalThreadId: string;
  threadId: string;
  inboundMessageId: string;
  route: ChannelJsonObject;
  metadata: ChannelJsonObject;
  createdAt: string;
  updatedAt: string;
}>;

export type ChannelDeliverySender = Readonly<{
  id: string;
  externalId: string;
  participantType: ChannelParticipantType;
  name?: string;
  agentId?: string;
}>;

/** JSON-safe durable output prepared before an external delivery attempt. */
export type ChannelDeliveryIntent = Readonly<{
  deliveryKey: string;
  bindingId: string;
  channelId: string;
  externalThreadId: string;
  threadId: string;
  messageId: string;
  route: ChannelJsonObject;
  sender: ChannelDeliverySender;
  content: ContentSequence;
  metadata: ChannelJsonObject;
}>;

/** Transient resolved body passed to Adapter.deliver. */
export type ChannelDeliveryAttempt = Readonly<{
  intent: ChannelDeliveryIntent;
  content: readonly ResolvedContent[];
}>;

export type ChannelDeliveryContext = Readonly<{
  namespace: string;
  channelId: string;
  channel: ChannelResource;
  signal: AbortSignal;
  now(): Date;
}>;

export type ChannelDeliveryReceipt = Readonly<{
  deliveryKey: string;
  delivered: number;
  providerIds?: readonly string[];
}>;

/** Executable behavior separately composed under the same channel alias. */
export type ChannelAdapter = Readonly<{
  accept(
    request: ChannelRequest,
    context: ChannelAcceptContext,
  ): ChannelAcceptResult | Promise<ChannelAcceptResult>;
  receive(
    input: ChannelJsonValue,
    context: ChannelReceiveContext,
  ): ChannelReceivedMessage | Promise<ChannelReceivedMessage>;
  /**
   * External delivery is at-least-once. deliveryKey remains stable across
   * retries and may be forwarded only where the provider supports idempotency.
   */
  deliver?(
    input: ChannelDeliveryAttempt,
    context: ChannelDeliveryContext,
  ): ChannelDeliveryReceipt | void | Promise<ChannelDeliveryReceipt | void>;
}>;

type EmptyChannelProviderMap = Readonly<Record<never, never>>;

/** Exact composition surface returned by every concrete Channel factory. */
export type ChannelProviderPlugin = CopilotzPlugin<
  string,
  string,
  readonly [typeof channelsPlugin],
  EmptyChannelProviderMap,
  EmptyChannelProviderMap,
  EmptyChannelProviderMap,
  Readonly<{ channels: Readonly<Record<string, ChannelResource>> }>,
  Readonly<{ channels: Readonly<Record<string, ChannelAdapter>> }>
>;

export const CHANNEL_INGRESS_INPUT_EVENT =
  "copilotz.channels.ingress.input" as const;

/** The complete durable channel ingress payload. */
export type ChannelIngressInput = Readonly<{
  /** Resource/Adapter map alias. */
  channelId: string;
  /** Stable provider occurrence identity. */
  id: string;
  /** Authenticated, sanitized, credential-free provider data. */
  input: ChannelJsonValue;
}>;

export type ChannelIngressEnvelope = CopilotzInputEnvelope<
  typeof CHANNEL_INGRESS_INPUT_EVENT,
  ChannelIngressInput
>;

export type ChannelIngressEnvelopeOptions = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
  metadata?: ChannelJsonObject;
}>;

export type ChannelIngressActionOutput = Readonly<{
  channelId: string;
  bindingId: string;
  threadId: string;
  messageId: string;
}>;

export type ChannelEgressActionInput = Readonly<{
  messageId: string;
}>;

export type ChannelEgressActionOutput = Readonly<{
  intents: readonly ChannelDeliveryIntent[];
}>;
