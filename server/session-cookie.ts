import type { SessionCookieOptions } from "../plugins/server/shared/contracts.ts";
import type { CredentialProjection } from "../runtime/authorization/credentials.ts";
/** Only transport code receives the credential; callers see public Action data. */
export function credentialHeaders(
  effects: readonly CredentialProjection[],
  options: SessionCookieOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const replacement = effects.findLast((effect) =>
    effect.claims.type === "session"
  );
  for (const effect of effects) {
    if (
      effect.claims.type === "clear" && replacement &&
      effect.claims.id !== replacement.claims.id
    ) continue;
    if (effect.claims.type === "flow") {
      if (effect.token) {
        headers["x-copilotz-flow"] = effect.token;
        headers["x-copilotz-flow-action"] = effect.claims.continuation!;
      }
      continue;
    }
    const maxAge = effect.claims.type === "clear" ? 0 : Math.max(
      0,
      Math.floor((Date.parse(effect.claims.expiresAt) - Date.now()) / 1000),
    );
    headers["set-cookie"] = sessionCookieHeader(
      effect.token ?? "",
      maxAge,
      options,
    );
    headers["x-copilotz-flow"] = "";
  }
  if (effects.length) headers["cache-control"] = "no-store";
  return headers;
}

export function sessionCookieHeader(
  token: string,
  maxAge: number,
  options: SessionCookieOptions = {},
): string {
  return `${options.name ?? "__Host-copilotz_session"}=${token}; Path=${
    options.path ?? "/"
  }; HttpOnly${options.secure === false ? "" : "; Secure"}; SameSite=${
    options.sameSite ?? "Lax"
  }; Max-Age=${maxAge}${options.domain ? `; Domain=${options.domain}` : ""}`;
}
