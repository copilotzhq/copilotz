/** Shared protected admission for trusted host and authorized HTTP requests. @module */
import type { ActionSchema } from "../../actions/types.ts";
import type {
  ApplicationSendInput,
  InternalCopilotzApplication,
} from "../types.ts";
import {
  type ServerActionRequest,
  serverActionRequestSchema,
  type ServerCollectionMutationRequest,
  serverCollectionMutationRequestSchema,
} from "./contracts.ts";

export function admitActionRequest(
  application: InternalCopilotzApplication,
  input: ApplicationSendInput & { payload: ServerActionRequest },
  inputSchema?: ActionSchema,
) {
  return application.sendProtected(
    input,
    serverActionRequestSchema(inputSchema),
    `server:${input.payload.requestId}`,
  );
}

export function admitCollectionMutationRequest(
  application: InternalCopilotzApplication,
  input: ApplicationSendInput & { payload: ServerCollectionMutationRequest },
  inputSchema?: ActionSchema,
) {
  return application.sendProtected(
    input,
    serverCollectionMutationRequestSchema(inputSchema),
    `server:${input.payload.requestId}`,
  );
}
