/**
 * Meta's Graph API, as a connected number uses it: sending text, marking
 * what was read (and showing it's typing), fetching media people sent, and
 * what a number is. Its access token goes in each request and nowhere else:
 * a failure says what Meta said, never the token.
 */

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

/** Sends text to someone (their WhatsApp id), and returns the sent message's id. */
export async function sendText(graph: Graph, to: string, body: string): Promise<string> {
  const sent = await call<{ messages?: { id: string }[] }>(
    graph,
    `${encodeURIComponent(graph.phoneId)}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body, preview_url: /https?:\/\//.test(body) },
    },
  );
  return sent.messages?.[0]?.id ?? "";
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
