/**
 * What email sign-in's Actions take, read one way everywhere: an address
 * (trimmed, lowercased, shaped like one), a password (8 characters at
 * least, taken as typed), a code (its six digits, whatever spaces or dashes
 * came with them), and the caller's network address as the route counted it.
 */
import { failure } from "../../../../runtime/mod.ts";

/** The shortest password taken. */
export const MIN_PASSWORD = 8;

/** Input schemas the Actions share. */
export const EMAIL = { type: "string", minLength: 3, maxLength: 254 } as const;
export const PASSWORD = { type: "string", maxLength: 1024 } as const;
export const CODE = { type: "string", maxLength: 20 } as const;
export const NAME = { type: "string", maxLength: 120 } as const;
/** The caller, as the route counted them (an address, or `unknown`): for the limits. */
export const ADDRESS = { type: "string", minLength: 1, maxLength: 80 } as const;

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An address as it's kept: trimmed and lowercased; refused when it isn't one. */
export function emailIn(text: string): string {
  const email = text.trim().toLowerCase();
  if (!SHAPE.test(email)) {
    throw failure("invalid", "Enter an email address, such as ana@example.com.", {
      public: true,
    });
  }
  return email;
}

/** A new password, refused when it's too short. */
export function passwordIn(password: string): string {
  if (password.length < MIN_PASSWORD) {
    throw failure("invalid", `Use at least ${MIN_PASSWORD} characters for your password.`, {
      public: true,
    });
  }
  return password;
}

/** A code's six digits, whatever spaces or dashes came with them; else none. */
export const codeIn = (text: string): string | undefined => {
  const digits = text.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
};
