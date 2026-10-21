import { credentialHeaders } from "./session-cookie.ts";
import { facadeIngress } from "./context.ts";
import { httpIngressMetadata } from "./adapter-metadata.ts";
/** Durable Action ingress and authorized result recovery. @module */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  type ServerEndpointDescriptor,
} from "../plugins/server/shared/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";
import { recordedOperationResult } from "../runtime/application/ingress/result.ts";
import { admitActionRequest } from "../runtime/application/ingress/admit.ts";
function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}
function header(
  headers: HttpRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
export async function actionResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: HttpRequest,
  context: FacadeContext,
): Promise<HttpResponse> {
  const input = request.body === undefined ? {} : request.body;
  const requestId = header(request.headers, "idempotency-key");
  if (!requestId) {
    throw appError(
      400,
      "idempotency_key_required",
      "Idempotency-Key is required.",
    );
  }
  const correlationId = context.serverIdentity.correlationId ??
    header(request.headers, "x-copilotz-correlation-id") ??
    `server:${requestId}`;
  const handle = await admitActionRequest(
    application,
    {
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      payload: {
        schema: SERVER_ACTION_REQUEST_SCHEMA,
        requestId,
        actionAlias: endpoint.actionAlias!,
        input,
        actionMetadata: context.serverActionMetadata,
      } as const,
      namespace: context.namespace,
      databaseSchema: context.databaseSchema,
      correlationId,
      causationId: context.serverIdentity.causationId,
      deduplicationId: context.serverIdentity.deduplicationId ??
        header(request.headers, "idempotency-key") ?? requestId,
      operationMetadata: {
        ...context.operationMetadata,
        ...(context.serverScope.actor
          ? { actorId: context.serverScope.actor.id }
          : {}),
      },
      metadata: {
        ...httpIngressMetadata(application, context.operationMetadata),
        ...({ sourceAdapter: "server" } as const),
      },
    },
    endpoint.inputSchema,
    facadeIngress(context),
  ).catch((error) => {
    if (error?.code === "event_deduplication_conflict") {
      throw appError(
        409,
        "idempotency_conflict",
        "Idempotency key was reused with different input.",
      );
    }
    throw error;
  });
  const status = await application.operationStatus({
    operationId: handle.operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  await handle.detach("http_receipt_returned");
  // Receipt acceptance is independent of current result access. A replay can
  // install committed credentials when authorized; failed projection stays on
  // the ordinary explicit result-recovery path.
  const completed = status?.state === "completed"
    ? await operationResult(application, context, handle.operationId).catch(
      () => undefined,
    )
    : undefined;
  return {
    ...(completed?.headers ? { headers: completed.headers } : {}),
    status: 202,
    data: {
      operationId: handle.operationId,
      correlationId: handle.correlationId,
      status: status?.state ?? "accepted",
      checkpoint: handle.replayCursor,
      acceptedAt: status?.acceptedAt,
    },
  };
}
export async function operationResult(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  operationId: string,
): Promise<HttpResponse> {
  const runtime = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  let authority = context.serverScope.authority!;
  const receiptAuthority = context.receiptAuthority ?? authority;
  const receipt = await runtime.authorization.logoutReceipt(
    receiptAuthority,
    operationId,
  );
  if (receipt) authority = receiptAuthority;
  if (receipt && ["accepted", "running"].includes(receipt.state)) {
    return { status: 202, data: { status: receipt.state } };
  }
  const read = async (): Promise<HttpResponse> => {
    const authorize = () =>
      runtime.authorization.operation(
        authority,
        operationId,
      );
    const result = await recordedOperationResult(
      application,
      context,
      operationId,
    ).catch(async (error) => {
      // Availability and terminal failures must not disclose hidden operations.
      await authorize();
      throw error;
    });
    const effects = result.kind === "action" && !result.pending
      ? await runtime.authorization.credentials.project(
        authority,
        operationId,
      )
      : [];
    if (result.kind !== "action" || result.pending) await authorize();
    return {
      status: result.pending ? 202 : 200,
      ...(result.kind === "collection" ? {} : {
        headers: {
          "cache-control": "no-store",
          ...credentialHeaders(effects, context.sessionCookie),
        },
      }),
      data: result.value,
      ...(!result.pending
        ? {
          seq: await runtime.operations.resultSequence(
            context.namespace ?? application.config.namespace!,
            operationId,
          ),
        }
        : {}),
    };
  };
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (receipt || !["forbidden", "revoked"].includes(code ?? "")) throw error;
    // Revocation may commit after the first lookup but before ordinary result
    // authorization. Recover that receipt once, through the same result policy.
    const current = await runtime.authorization.logoutReceipt(
      receiptAuthority,
      operationId,
    );
    if (current) authority = receiptAuthority;
    if (current && ["accepted", "running"].includes(current.state)) {
      return { status: 202, data: { status: current.state } };
    }
    if (current?.state === "completed") return await read();
    throw error;
  }
}
