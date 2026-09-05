import type {
  ServerAuthorizedScope,
  ServerConstraints,
} from "../plugins/server/internal/contracts.ts";

export type FacadeContext = Readonly<{
  serverScope: ServerAuthorizedScope;
  serverConstraints: ServerConstraints;
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
