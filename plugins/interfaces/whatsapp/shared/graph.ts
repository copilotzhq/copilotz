/**
 * Meta's Graph API, as a connected number uses it: sending a message (text,
 * buttons, a list, a carousel, an image, a document), uploading a file to
 * send, marking what was read (and showing it's typing), fetching media
 * people sent, and what a number is. Its access token goes in each request and nowhere else: a failure
 * says what Meta said, never the token.
 */
import type { WaMedia, WaPart } from "./parts.ts";

/** A number to call the Graph API for: where it is, its phone number id, its token. */
export type Graph = { base: string; phoneId: string; token: string };

/** What the Graph API refused, with its status and Meta's own code (190: the token). */
export type GraphError = Error & { code: "graph"; status: number; graph?: number };

async function call<T>(graph: Graph, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${graph.base}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${graph.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const said = await response.json().catch(() => ({})) as {
    error?: { message?: string; code?: number };
  };
  if (!response.ok || said.error) {
    throw Object.assign(
      new Error(`WhatsApp said: ${said.error?.message ?? `HTTP ${response.status}`}`),
      {
        code: "graph" as const,
        status: response.status,
        ...(said.error?.code !== undefined ? { graph: said.error.code } : {}),
      },
    );
  }
  return said as T;
}

/** Whether a failure means the token no longer works (expired, revoked). */
export const tokenRefused = (error: unknown) => {
  const e = error as Partial<GraphError>;
  return e?.code === "graph" && (e.status === 401 || e.graph === 190);
};

/** What a number is, as Meta knows it: proves the token works for it. */
export const numberInfo = (graph: Graph) =>
  call<{ id: string; display_phone_number?: string; verified_name?: string }>(
    graph,
    `${encodeURIComponent(graph.phoneId)}?fields=display_phone_number,verified_name`,
  );

/**
 * Whether a part can't go as it is: Meta refused it (a 400 that isn't the
 * token, 190; the 24 hours to answer freely, 131047; or a rate), or it
 * couldn't be made (`unsendable`: a carousel's picture with no link to it).
 */
export const refused = (error: unknown) => {
  const e = error as Partial<GraphError> | { code?: string };
  if (e?.code === "unsendable") return true;
  const g = e as Partial<GraphError>;
  return g?.code === "graph" && g.status === 400 &&
    ![190, 131047, 130429, 131056].includes(g.graph ?? 0);
};

/** Media as the Graph API takes it: a link, or the id of one uploaded. */
export type Sendable = { link: string } | { id: string };

/**
 * What sends a part's media: a link to it, or what Meta knows it by once
 * uploaded; `linked`: only a link will do (a carousel's pictures).
 */
export type Resolve = (media: WaMedia, linked?: boolean) => Promise<Sendable>;

/** A part, as the Graph API's message (its media resolved). */
async function wireOf(part: WaPart, resolve: Resolve): Promise<Record<string, unknown>> {
  const footer = (text?: string) => text ? { footer: { text } } : {};
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: { body: part.text, preview_url: /https?:\/\//.test(part.text) },
      };
    case "buttons": {
      const header = typeof part.header === "string"
        ? { header: { type: "text", text: part.header } }
        : part.header
        ? { header: { type: "image", image: await resolve(part.header) } }
        : {};
      return {
        type: "interactive",
        interactive: {
          type: "button",
          ...header,
          body: { text: part.text },
          ...footer(part.footer),
          action: {
            buttons: part.buttons.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    }
    case "list":
      return {
        type: "interactive",
        interactive: {
          type: "list",
          ...(part.header ? { header: { type: "text", text: part.header } } : {}),
          body: { text: part.text },
          ...footer(part.footer),
          action: { button: part.button, sections: part.sections },
        },
      };
    case "carousel":
      return {
        type: "interactive",
        interactive: {
          type: "carousel",
          body: { text: part.text },
          action: {
            cards: await Promise.all(part.cards.map(async (card, i) => ({
              card_index: i,
              type: "cta_url",
              header: { type: "image", image: await resolve(card.image, true) },
              ...(card.body ? { body: { text: card.body } } : {}),
              action: {
                buttons: card.buttons.map((b) => ({
                  type: "quick_reply",
                  quick_reply: { id: b.id, title: b.title },
                })),
              },
            }))),
          },
        },
      };
    case "image":
      return {
        type: "image",
        image: { ...await resolve(part.image), ...(part.caption ? { caption: part.caption } : {}) },
      };
    case "document":
      return {
        type: "document",
        document: {
          ...await resolve(part.document),
          filename: part.filename,
          ...(part.caption ? { caption: part.caption } : {}),
        },
      };
  }
}

/** Sends a part to someone (their WhatsApp id), and returns the sent message's id. */
export async function sendPart(
  graph: Graph,
  to: string,
  part: WaPart,
  resolve: Resolve,
): Promise<string> {
  const sent = await call<{ messages?: { id: string }[] }>(
    graph,
    `${encodeURIComponent(graph.phoneId)}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      ...await wireOf(part, resolve),
    },
  );
  return sent.messages?.[0]?.id ?? "";
}

/** Uploads a file to Meta, for the number to send: its id there (Meta keeps it for a while). */
export async function uploadMedia(
  graph: Graph,
  file: { bytes: Uint8Array; type: string; name: string },
): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.type);
  form.set("file", new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
  const response = await fetch(`${graph.base}/${encodeURIComponent(graph.phoneId)}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${graph.token}` },
    body: form,
  });
  const said = await response.json().catch(() => ({})) as {
    id?: string;
    error?: { message?: string; code?: number };
  };
  if (!response.ok || said.error || !said.id) {
    throw Object.assign(
      new Error(`WhatsApp said: ${said.error?.message ?? `HTTP ${response.status}`}`),
      {
        code: "graph" as const,
        status: response.status,
        ...(said.error?.code !== undefined ? { graph: said.error.code } : {}),
      },
    );
  }
  return said.id;
}

/** Marks a message read (two blue ticks) and, with `typing`, shows it's being answered. */
export const markRead = (graph: Graph, message: string, typing: boolean) =>
  call(graph, `${encodeURIComponent(graph.phoneId)}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: message,
    ...(typing ? { typing_indicator: { type: "text" } } : {}),
  });

/** A file someone sent: its bytes, as base64, unless it's larger than `max`. */
export async function fetchMedia(
  graph: Graph,
  id: string,
  max: number,
): Promise<{ data: string; type: string; size: number }> {
  const meta = await call<{ url: string; mime_type?: string; file_size?: number }>(
    graph,
    encodeURIComponent(id),
  );
  const tooLarge = () =>
    Object.assign(new Error(`That file is over ${Math.round(max / 1024 / 1024)} MB.`), {
      code: "too_large",
    });
  if ((meta.file_size ?? 0) > max) throw tooLarge();
  const response = await fetch(meta.url, { headers: { authorization: `Bearer ${graph.token}` } });
  if (!response.ok) {
    throw Object.assign(new Error(`WhatsApp said: HTTP ${response.status} for a file`), {
      code: "graph",
      status: response.status,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > max) throw tooLarge();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { data: btoa(binary), type: meta.mime_type ?? "", size: bytes.length };
}
