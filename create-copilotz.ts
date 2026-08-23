import { createCopilotz as createEmbeddedCopilotz } from "./runtime/application/copilotz.ts";
import type { CreateCopilotzOptions as RuntimeCreateCopilotzOptions } from "./runtime/application/copilotz.ts";
import { createCopilotzGateway as createGateway } from "./runtime/application/gateway.ts";
import type { CreateCopilotzGatewayOptions as RuntimeCreateCopilotzGatewayOptions } from "./runtime/application/gateway.ts";
import { createCopilotzWorker as createWorker } from "./runtime/application/worker.ts";
import type { CreateCopilotzWorkerOptions as RuntimeCreateCopilotzWorkerOptions } from "./runtime/application/worker.ts";

export type CreateCopilotzOptions = RuntimeCreateCopilotzOptions;
export type CreateCopilotzGatewayOptions = RuntimeCreateCopilotzGatewayOptions;
export type CreateCopilotzWorkerOptions = RuntimeCreateCopilotzWorkerOptions;

/** Composes exactly the plugins, resources, and adapters supplied by the caller. */
export function createCopilotz(
  options: CreateCopilotzOptions = {},
  lifecycle?: Parameters<typeof createEmbeddedCopilotz>[1],
): ReturnType<typeof createEmbeddedCopilotz> {
  return createEmbeddedCopilotz(options, lifecycle);
}

export function createCopilotzGateway(
  options: CreateCopilotzGatewayOptions = {},
  lifecycle?: Parameters<typeof createGateway>[1],
): ReturnType<typeof createGateway> {
  return createGateway(options, lifecycle);
}

export function createCopilotzWorker(
  options: CreateCopilotzWorkerOptions,
  lifecycle?: Parameters<typeof createWorker>[1],
): ReturnType<typeof createWorker> {
  return createWorker(options, lifecycle);
}
