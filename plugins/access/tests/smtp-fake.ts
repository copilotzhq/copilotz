/**
 * A mail server, faked, for tests: it speaks enough SMTP for a client to
 * send through it (EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA,
 * QUIT), plain, moving to TLS with STARTTLS, or TLS from the start, and keeps
 * what each conversation said. It listens on `node:net` and `node:tls`, as
 * Node, Deno and Bun all do; a connection moving to TLS is handed, as it is,
 * to a TLS server of its own, which every runtime can be.
 *
 * Its certificate is for `localhost` and 127.0.0.1, under a CA made for these
 * tests alone (openssl, 2026-11-15, RSA 2048, until 2126): trust `CA` to
 * reach it, and nothing else.
 */
import net from "node:net";
import tls from "node:tls";

/** The tests' CA: what a client trusts to reach the fake server. */
export const CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIC3jCCAcagAwIBAgIJAIqQ6X0lEnKqMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV",
  "BAMMEENvcGlsb3R6IHRlc3QgQ0EwIBcNMjYxMTE1MTg0NzQ2WhgPMjEyNjEwMjIx",
  "ODQ3NDZaMBsxGTAXBgNVBAMMEENvcGlsb3R6IHRlc3QgQ0EwggEiMA0GCSqGSIb3",
  "DQEBAQUAA4IBDwAwggEKAoIBAQDK7KDwA0M02yKdqZUZAHTO6Gc4NgF7dbsUf4No",
  "l3HIkY1KsC3TVAHrmPGxOljjkA1k5hhykgKBdtN1g28DizLE5BICApjqy3f3OCFV",
  "pyMojEGxxonq8AnEEZemzuQaJyuIouczQqzCc8xC4d3w2wUV6s7kzSspX9toISSC",
  "KTGsyl5oOGSkgd8Fw1Z/31nAVAauGZn4rZ+GcN9FfVcEIGTdOR7jOVDxuIUQ6+82",
  "iUOA2ZZYSnUJTp8Tr1lyhcYOb7AQP7OvHYfeRAYrwOSfFgTW1DSv2tRN4jCN5WpS",
  "znGLiXTZqUYPYL+ecVhxqSyTQ8xreqL0b5+YrAxiZXzq0qrjAgMBAAGjIzAhMA8G",
  "A1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IB",
  "AQAZbVwr9cMjgdGI+IdiLppU3fw17v3DusbOqdzmjnAut5geXENj8rUwqmZYboQj",
  "X3QOm9yTBJjvI80reTx/RbJ+TqXnkGm2+jQvdjLfdSP3kqNovfwXFA4yCD7M5yaN",
  "uL1OPkbUbdbgM0psHBLHw3ybphn3ZcjZ0R0OphqO6H/c57pW6c0g00QHzQUqYmDo",
  "m3n/O0R6vTEWcJxdwmfWytvuTTMMVrBcW0WKiNMoKJ0he63tjSjIVb043yzNAUZn",
  "UddQ5ax8wis/4gq33r9Mt1IvAGq3BWvSOmTUEzmYisqQmcVADOjbsSjbbuCdwNNt",
  "zI4BpMWnxG1SDqkGTSn8kWCC",
  "-----END CERTIFICATE-----",
].join("\n");

const CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIC/zCCAeegAwIBAgIJAPjll/hvgupEMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV",
  "BAMMEENvcGlsb3R6IHRlc3QgQ0EwIBcNMjYxMTE1MTg0NzQ2WhgPMjEyNjEwMjIx",
  "ODQ3NDZaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQAD",
  "ggEPADCCAQoCggEBAKQjox8StdLcliJzCNjgqggLjDfkuUmhVZ5ZpqQKMQDTk1um",
  "idS+XIrAXeqRRo9QByEb1jNDcGYJbh7XAppr2+3U/RB41cnFyhvTs2WtnKQiAoSK",
  "SbUQqqJNdy03XzH2Oo5BEcpDneLLHx1Xs3ywkGziNf23o2ChqmeNtw9ApvBzw8Ir",
  "1Qf5yCKqQtgWd0bAPAfN95n4oIftZVWNBxJ5iZ8njdabSE4rlm2sMXLMfbqvOerK",
  "RgFrfLO3RdAOOxqQS7MQ9+PLq8YfAx71d51e4aRhkxv2+LYg+guuM8MF8ywxKkgZ",
  "DjIGtsPPdc5zBCGdwQlwlp6vpm8C23N4X+yvj3kCAwEAAaNLMEkwCQYDVR0TBAIw",
  "ADALBgNVHQ8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwGgYDVR0RBBMwEYIJ",
  "bG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQAJSU9DLCjvg6Yjk12Q",
  "+8l8t4Sidk86LRMgCASVTN+bi7AWbj0Vto8X8LPeN8AvoC0FkYSTLNbGUXQJhVWX",
  "3LHLZZONKVtl8PLJXJU/6zJFQgSzOAB/gOdZsCM0uOeUT7dTjUvzFonCAa6xkpiZ",
  "3z/OaV7thXLoImRXZ7KBWhSTp/Zca3WNqFy1B8KCUV652zHyjM73ynubHbWhQDef",
  "2o5+jMwleDskd8ilSVEYOA86JG+uZksnf27qZPzbAVmMJihiXSl1wENA63qR3B3f",
  "VtDZHIb67/Sa497lEe8z/r3c2J/gi47SdkdlF7LHPEE789AZYcEtJ8/k04a8gVnM",
  "6p38",
  "-----END CERTIFICATE-----",
].join("\n");

const KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCkI6MfErXS3JYi",
  "cwjY4KoIC4w35LlJoVWeWaakCjEA05NbponUvlyKwF3qkUaPUAchG9YzQ3BmCW4e",
  "1wKaa9vt1P0QeNXJxcob07NlrZykIgKEikm1EKqiTXctN18x9jqOQRHKQ53iyx8d",
  "V7N8sJBs4jX9t6NgoapnjbcPQKbwc8PCK9UH+cgiqkLYFndGwDwHzfeZ+KCH7WVV",
  "jQcSeYmfJ43Wm0hOK5ZtrDFyzH26rznqykYBa3yzt0XQDjsakEuzEPfjy6vGHwMe",
  "9XedXuGkYZMb9vi2IPoLrjPDBfMsMSpIGQ4yBrbDz3XOcwQhncEJcJaer6ZvAttz",
  "eF/sr495AgMBAAECggEBAIKfAZ8myp+Ff8zmcrH1CBri5bFNSc64n2QmwCBnI9we",
  "g3Q6MhGldAvPTm3vMpG2BBZrCqk9D+ODuai9PosZLqo0BzfmkWvDBTXj4S4XXUKY",
  "9hv32PRI0SHcN+051X3zD2JJkhi+epUTRC2br3CZKjYcRw8j5tZtkShbdMSklLVg",
  "hEtYM2m6avFzCgvbAFPQOtOg2eE//icwBcMJQ/A8IZJ6YWulZ65mlLAgq2ZMgiMi",
  "X2QfsSCNxr0yJDDrMwjOuisxUNVtI9dYsQZX4zlRaY9/HQZ3qlB9lHWcDLiCEODQ",
  "80GEIhcO2S1GqTM/WC3GE6qi4BYuPeVV4Dfj84FCpSkCgYEA14PfxYCygAxSLx5D",
  "vBfv9ud3oU3U8NM6NQ+sEzbvrWurxS03hWKv+2E4YbvLrqnAHOXX9VOEycJsOO4d",
  "HO7tyayZGPAe0WqSLUNfSxeWp9/h0jLVpROvo+VHbVXFzIsrFVtYchho248nRWej",
  "FCqNDC/354hEsdkCr+ZXgGUx6vMCgYEAwvkYFddWao5CgGgILKoQc3Gp3Py9TpRm",
  "oVxLv2/TPmh++ZH7Uh9f6AVZFPCt0ChYY58PP/CiHEtwaEY+96/9ZkNRKXq/oHbC",
  "riSA33tnALdPt01C0ZjDey8bUcSFRCKDCwHcssgPwLz80d0TcUKn0E3rQWpwyVB3",
  "p+9RaWn9XuMCgYAzACUzYupa/Q9x0RKsb2m9HzejN3z95K6wod3Ryj1b59AFYFb0",
  "PM9yiKZEEqH32nn5HLdHehVBfb4IlujS0QP6ptqwGRrh6ftftMLXTWS8o3GYQaln",
  "YEo/WeHWUOb3KbPvYOeEUJx34N+lQApKmms4iB19cDT5dWZ6Y+MvIkN22wKBgCMK",
  "JTv3oT4xJt5w09dDEQXOTZq7iUIQBYnGTo6vCCXVHcy4YZRWsyO9ok7TGkmolooA",
  "0frJwjiXjjIPPc3BwSaZvoJX3wx1i3NEeCyxvscwKpFkvzdv3uHKi3xcdx7RnP9j",
  "bEhtD/exfzYwJwhZ1FLpTfhJqs9jOL3jkpwBQlnFAoGAK329DVrHU5NQP7ewLq/0",
  "d7CCKrqJiFzkD5xWXKJvqKlDpCug2KOZn2a9nECeOyuzC+9krwNMIhGwRfQboaJB",
  "Fuvi+K/CtKEoThaN9XgfSsETzHgkSdJZt8KQE990i5NGTWet/uXfnFZFgB9x0Qjg",
  "UV1kjz6VXV9umr993EsXEu0=",
  "-----END PRIVATE KEY-----",
].join("\n");

/** What one conversation said: who it greeted as, signed in as, sent from and to, and the message. */
export type Said = {
  secure: boolean;
  ehlo: string[];
  auth?: { way: string; user: string; password: string };
  from?: string;
  to: string[];
  data?: string;
};

export type FakeSmtp = {
  port: number;
  /** Each conversation, as it went (one moved to TLS goes on in another, `secure`). */
  said: Said[];
  close(): Promise<void>;
};

const decode = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

/**
 * A fake server: `tls` says how it secures (`starttls`, `implicit`, or
 * `none`), `auth` the ways it offers to sign in, and `user` and `password`
 * whom it lets in.
 */
export async function fakeSmtp(options: {
  tls?: "starttls" | "implicit" | "none";
  auth?: ("PLAIN" | "LOGIN")[];
  user?: string;
  password?: string;
} = {}): Promise<FakeSmtp> {
  const mode = options.tls ?? "starttls";
  const ways = options.auth ?? ["PLAIN", "LOGIN"];
  const said: Said[] = [];
  const sockets = new Set<net.Socket>();

  const converse = (socket: net.Socket, secure: boolean, greet: boolean) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const now: Said = { secure, ehlo: [], to: [] };
    said.push(now);
    let buffer = "";
    let data: string | undefined;
    let login: { user?: string } | undefined;
    const reply = (text: string) => socket.write(`${text}\r\n`);
    const line = (text: string) => {
      if (login) {
        if (login.user === undefined) {
          login.user = decode(text);
          return reply("334 UGFzc3dvcmQ6");
        }
        const password = decode(text);
        now.auth = { way: "LOGIN", user: login.user, password };
        login = undefined;
        return reply(
          password === options.password && now.auth.user === options.user ? "235 ok" : "535 no",
        );
      }
      const [verb, ...rest] = text.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": {
          now.ehlo.push(rest.join(" "));
          const offers = [
            ...(mode === "starttls" && !secure ? ["STARTTLS"] : []),
            ...(ways.length ? [`AUTH ${ways.join(" ")}`] : []),
            "8BITMIME",
          ];
          return reply(
            ["fake", ...offers].map((o, i, all) => `250${i === all.length - 1 ? " " : "-"}${o}`)
              .join("\r\n"),
          );
        }
        case "STARTTLS": {
          reply("220 go ahead");
          socket.removeAllListeners("data");
          const inner = net.connect({
            host: "127.0.0.1",
            port: (secured.address() as net.AddressInfo).port,
          });
          sockets.add(inner);
          inner.on("error", () => {});
          socket.pipe(inner);
          inner.pipe(socket);
          return;
        }
        case "AUTH": {
          if (rest[0] === "PLAIN") {
            const [, user, password] = decode(rest[1] ?? "").split("\0");
            now.auth = { way: "PLAIN", user, password };
            return reply(
              user === options.user && password === options.password ? "235 ok" : "535 no",
            );
          }
          login = {};
          return reply("334 VXNlcm5hbWU6");
        }
        case "MAIL":
          now.from = /<(.*)>/.exec(text)?.[1];
          return reply("250 ok");
        case "RCPT":
          now.to.push(/<(.*)>/.exec(text)?.[1] ?? "");
          return reply("250 ok");
        case "DATA":
          data = "";
          return reply("354 go on");
        case "QUIT":
          reply("221 bye");
          return socket.end();
        default:
          return reply("500 what");
      }
    };
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        if (data !== undefined) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          now.data = buffer.slice(0, end + 2).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end + 5);
          data = undefined;
          reply(`250 queued as ${said.length}`);
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        line(text);
      }
    });
    if (greet) reply("220 fake ESMTP");
  };

  // The TLS half: what a connection moving to TLS is handed to (it greets no more), or, from the
  // start, the server itself.
  const secured = tls.createServer(
    { key: KEY, cert: CERT },
    (socket) => converse(socket as unknown as net.Socket, true, mode === "implicit"),
  );
  const plain = net.createServer((socket) => converse(socket, false, true));
  const listen = (server: net.Server) =>
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  await listen(secured);
  await listen(plain);
  const port = ((mode === "implicit" ? secured : plain).address() as net.AddressInfo).port;
  return {
    port,
    said,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [secured, plain].map((server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
        ),
      );
    },
  };
}
