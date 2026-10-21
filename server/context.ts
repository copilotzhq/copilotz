import type { OwnerIngressProof } from "../runtime/application/ingress/authority.ts";
import type {
  ServerAuthorizedScope,
} from "../plugins/server/shared/contracts.ts";

export type FacadeContext = Readonly<{
  invalidSessionCookie?: true;
  receiptAuthority?:
    import("../runtime/authorization/authority.ts").AuthenticatedAuthority;
  sessionCookie?:
    import("../plugins/server/shared/contracts.ts").SessionCookieOptions;
  serverScope: ServerAuthorizedScope;
  serverRequest: Request;
  serverEndpointKey: string;
  serverParams: Readonly<Record<string, string>>;
  serverActionMetadata: Readonly<Record<string, unknown>>;
  operationMetadata: Readonly<Record<string, unknown>>;
  serverIdentity: Readonly<Record<string, string>>;
  serverSignal: AbortSignal;
  namespace?: string;
  databaseSchema?: string;
}>;

// Enumerable symbol survives package-owned context copies; JSON/wire values cannot supply it.
const ingressKey = Symbol("ownerIngress");
export function withFacadeIngress<T extends object>(
  context: T,
  proof?: OwnerIngressProof,
): T {
  return proof ? Object.assign(context, { [ingressKey]: proof }) : context;
}
export function facadeIngress(
  context: FacadeContext,
): OwnerIngressProof | undefined {
  return (context as FacadeContext & { [ingressKey]?: OwnerIngressProof })[
    ingressKey
  ];
}
