/**
 * Sending: RFC 8291's own example encrypts to its exact bytes; a fresh
 * message decrypts in the browser's place; the VAPID JWT verifies with the
 * app's public key and names the push service's origin; `push.send` reaches
 * each of a person's devices and nobody else's, forgets one its service says
 * is gone, and is the app's own code's alone.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { push, vapidKeys } from "../mod.ts";
import { b64url, encrypt, senderOf, vapid } from "../shared/webpush.ts";

const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

test("RFC 8291's example encrypts to its bytes", async () => {
  const body = await encrypt(b64url.decode(RFC.plaintext), {
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
  }, { salt: b64url.decode(RFC.salt), sender: await senderOf(RFC.asPublic, RFC.asPrivate) });
  assertEquals(b64url.encode(body.subarray(0, 86)), b64url.encode(b64url.decode(RFC.header)));
  assertEquals(b64url.encode(body.subarray(86)), RFC.ciphertext);
});

/** What a browser does with a push it gets (RFC 8291, the receiving side). */
async function decrypt(
  body: Uint8Array,
  ua: CryptoKeyPair,
  uaPublic: Uint8Array,
  auth: Uint8Array,
) {
  const enc = new TextEncoder();
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          key as Uint8Array<ArrayBuffer>,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        data as Uint8Array<ArrayBuffer>,
      ),
    );
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]);
  const as = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: as }, ua.privateKey, 256),
  );
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic, 1]);
  const ikm = await hmac(await hmac(auth, ecdh), info);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + body[20])),
  );
  assertEquals(plain.at(-1), 2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function browser() {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64url.encode(uaPublic), auth: b64url.encode(auth) },
    read: (body: Uint8Array) => decrypt(body, ua, uaPublic, auth),
  };
}

test("a fresh message decrypts in the browser's place", async () => {
  const b = await browser();
  const body = await encrypt(new TextEncoder().encode("Ana: can you look?"), b.keys);
  assertEquals(await b.read(body), "Ana: can you look?");
});

test("the VAPID JWT verifies with the app's key, for the push service's origin", async () => {
  const app = { ...await vapidKeys(), contact: "mailto:ops@example.com" };
  const now = Date.UTC(2026, 10, 26);
  const header = await vapid("https://fcm.googleapis.com/fcm/send/abc", app, now);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assertEquals(k, app.publicKey);
  const [h, c, s] = jwt.split(".");
  const claims = JSON.parse(new TextDecoder().decode(b64url.decode(c)));
  assertEquals(claims, {
    aud: "https://fcm.googleapis.com",
    exp: now / 1000 + 12 * 3600,
    sub: "mailto:ops@example.com",
  });
  const key = await crypto.subtle.importKey(
    "raw",
    b64url.decode(app.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64url.decode(s),
      new TextEncoder().encode(`${h}.${c}`),
    ),
  );
});

test("push.send reaches each of a person's devices, forgets a gone one, and is the app's alone", async () => {
  const app = { ...await vapidKeys(), contact: "mailto:ops@example.com" };
  const ana: Actor = { kind: "person", id: "ana" };
  const bob: Actor = { kind: "person", id: "bob" };
  const phone = await browser();
  const laptop = await browser();
  const bobs = await browser();
  const posted: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [push, definePlugin({ name: "app", resources: { push: app } })],
    fetch: async (url, init) => {
      const href = String(url);
      posted.push({
        url: href,
        headers: new Headers(init?.headers),
        body: new Uint8Array(init!.body as Uint8Array),
      });
      return new Response(null, { status: href.endsWith("/gone") ? 410 : 201 });
    },
  });
  try {
    const on = (who: Actor, endpoint: string, keys: { p256dh: string; auth: string }) =>
      rt.call("push.subscribe", { endpoint, keys }, { actor: who });
    await on(ana, "https://push.example.com/phone", phone.keys);
    await on(ana, "https://push.example.com/gone", laptop.keys);
    await on(bob, "https://push.example.com/bob", bobs.keys);
    const notice = { title: "Ana's agent", body: "May I run this?", url: "/chat/t1", tag: "t1" };
    await assertRejects(() => rt.call("push.send", { person: "ana", notice }, { actor: ana }));
    assertEquals(await rt.call("push.send", { person: "ana", notice }), {
      sent: 1,
      removed: 1,
      failed: 0,
    });
    assertEquals(posted.map((p) => p.url).sort(), [
      "https://push.example.com/gone",
      "https://push.example.com/phone",
    ]);
    const toPhone = posted.find((p) => p.url.endsWith("/phone"))!;
    assertEquals(toPhone.headers.get("content-encoding"), "aes128gcm");
    assert(toPhone.headers.get("authorization")!.startsWith("vapid t="));
    assertEquals(JSON.parse(await phone.read(toPhone.body)), notice);
    // The gone one is forgotten: the next send reaches only the phone.
    posted.length = 0;
    await rt.call("push.send", { person: "ana", notice });
    assertEquals(posted.map((p) => p.url), ["https://push.example.com/phone"]);
  } finally {
    await rt.close();
  }
});

test("without a key pair, push.send sends nothing", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [push],
    fetch: () => Promise.reject(new Error("nothing should be sent")),
  });
  try {
    assertEquals(await rt.call("push.send", { person: "ana", notice: { title: "x" } }), {
      sent: 0,
      removed: 0,
      failed: 0,
    });
  } finally {
    await rt.close();
  }
});
