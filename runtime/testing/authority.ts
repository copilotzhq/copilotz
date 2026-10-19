import { captureCollectionInvocation } from "../authorization/invocation.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../authorization/authority.ts";
/** Explicit host authority for fixtures; never installed by a production factory. */
export function testAuthority(
  databaseSchema: string,
  namespace = "space",
  id = "member",
): AuthenticatedAuthority {
  return {
    version: 1,
    principal: { kind: "api-key", id },
    scope: {
      owner: "schema",
      databaseSchema,
      namespace,
      tenant: "fixture",
      bindings: {},
    },
    validity: credentialValidity(new Date()),
    policy: { id: "fixture", revision: "1" },
    requestFacts: {
      endpoint: "fixture",
      transport: "core",
      operation: "invoke",
      params: {},
      input: null,
    },
    provenance: { ingress: "core", source: "fixture" },
    dependencies: [],
    authorityBasis: { kind: "credential", id },
  };
}

import { withRetainedAuthority } from "../authorization/binding.ts";
export function bindTestActions<T extends object>(
  actions: T,
  authority: AuthenticatedAuthority,
): T {
  return new Proxy(actions, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== "function") {
        return member && typeof member === "object"
          ? bindTestActions(member, authority)
          : member;
      }
      return (...args: unknown[]) =>
        captureCollectionInvocation()?.authority
          ? Reflect.apply(member, target, args)
          : withRetainedAuthority(
            authority,
            new AbortController().signal,
            () => Reflect.apply(member, target, args),
          );
    },
  });
}
