/**
 * bcrypt hashes another app kept (`$2a$`, `$2b$`, `$2y$`): OpenWall's and
 * PHP's published vectors, and ones bcryptjs made, verify; Blowfish's
 * starting state is pi's digits, worked out here again; costs past 15 and
 * `$2x$` aren't read. Imported by email, one signs in and is hashed again
 * our way.
 */
import { assertEquals, assertMatch } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, email, emailSignIn, verifyPassword } from "../mod.ts";
import { bcrypt } from "../email/shared/bcrypt.ts";
import { PI_HEX } from "../email/shared/pi.ts";
import { test } from "../../../testing/mod.ts";

/** Hashes and the passwords they were made from. */
const VECTORS: [string, string][] = [
  // OpenWall's crypt_blowfish tests.
  ["$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW", "U*U"],
  ["$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK", "U*U*"],
  ["$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a", "U*U*U"],
  ["$2a$05$CCCCCCCCCCCCCCCCCCCCC.7uG0VCzI2bS7j6ymqJi9CdcdxiRTWNy", ""],
  [
    "$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui",
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789chars after 72 are ignored",
  ],
  // PHP's password_verify documentation.
  ["$2y$07$BCryptRequires22Chrcte/VlQH0piJtjXl.0t1XkA8pw9dMXTpOq", "rasmuslerdorf"],
  ["$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a", "rasmuslerdorf"],
  // bcryptjs 3.0.3.
  ["$2b$10$abcdefghijklmnopqrstuuGGgFFcYeueaAql8Z7U7CnCTRw4DR77W", "correct horse battery staple"],
  ["$2b$04$......................PZH8V4smr3Aed9e00CzKHwa5Yrk72Ei", "ação é 東京 🍣"],
];

test("bcrypt: published vectors verify, and nothing else does", async () => {
  for (const [hash, password] of VECTORS) {
    assertEquals(await bcrypt(password, hash.slice(0, 29)), hash);
    assertEquals(await verifyPassword(password, hash), true);
    assertEquals(await verifyPassword(`${password}x`, hash), password.length >= 72);
  }
  // `$2b$` and `$2y$` are the same hash for the same password.
  const [php] = VECTORS.filter(([h]) => h.startsWith("$2y$07$"));
  assertEquals(await verifyPassword("rasmuslerdorf", php[0].replace("$2y$", "$2b$")), true);
  // `$2x$` (crypt_blowfish's buggy one), costs past 15, and broken ones aren't read.
  for (
    const unread of [
      "$2x$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
      "$2b$16$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
      "$2b$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOe",
    ]
  ) {
    assertEquals(await verifyPassword("U*U", unread), false);
  }
});

test("bcrypt: Blowfish starts from pi's first 8,336 hex digits", () => {
  // Machin: pi = 16 atan(1/5) - 4 atan(1/239), in fixed point of 16^(digits + 8).
  const digits = 8336;
  const one = 16n ** BigInt(digits + 8);
  const atanInverse = (x: bigint) => {
    let term = one / x;
    let total = term;
    for (let n = 1n; term; n++) {
      term /= x * x;
      total += (n % 2n ? -1n : 1n) * (term / (2n * n + 1n));
    }
    return total;
  };
  const fraction = 16n * atanInverse(5n) - 4n * atanInverse(239n) - 3n * one;
  assertEquals(fraction.toString(16).padStart(digits + 8, "0").slice(0, digits), PI_HEX);
});

test("moving in with bcrypt: it signs in, and is hashed again our way", async () => {
  const store = memoryStore();
  const rt = await createRuntime({
    store,
    plugins: [
      ...access,
      email,
      emailSignIn,
      definePlugin({
        name: "app",
        resources: {
          links: {
            origin: "http://localhost:8000",
            secret: "the-app-secret-for-tests-0123456789",
          },
          email: { adapter: "console" },
        },
      }),
    ],
  });
  try {
    const [hash, password] = VECTORS.find(([h]) => h.startsWith("$2y$10$"))!;
    await rt.call("email.import", { person: "rails-7", email: "ana@example.com", hash });
    const signed = await rt.call<{ person: string }>("email.sign-in", {
      email: "ana@example.com",
      password,
    });
    assertEquals(signed.person, "rails-7");
    const [kept] = await store.find("email_login", { _id: "ana@example.com" }) as unknown as {
      hash: string;
    }[];
    assertMatch(kept.hash, /^pbkdf2-sha256\$6x100000\$/);
    assertEquals(await verifyPassword(password, kept.hash), true);
  } finally {
    await rt.close();
  }
});
