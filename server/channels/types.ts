/**
 * Shared types for Copilotz channel handlers.
 *
 * Channels receive a framework-independent {@link ChannelRequest} and return a
 * {@link ChannelResponse}. Streaming channels (e.g. web) populate the
 * `events` async iterable; push-based channels (e.g. WhatsApp, Zendesk) send
 * responses to the platform API internally and return a plain status body.
 *
 * @module
 */

/** Framework-independent representation of an incoming HTTP request. */
export type ChannelRequest = {
  method: string;
  url: string;
  headers: Headers;
  /** Parsed request body (JSON object, form data, etc.). */
  body: unknown;
  /** Raw body bytes — required by channels that verify HMAC signatures. */
  rawBody?: Uint8Array;
};

/** A single typed event emitted by a streaming channel. */
export type ChannelEvent = {
  event: string;
  data: unknown;
};

/** Framework-independent response returned by every channel handler. */
export type ChannelResponse = {
  status: number;
  body: unknown;
  /** Present only for streaming channels (e.g. web). */
  events?: AsyncIterable<ChannelEvent>;
};
