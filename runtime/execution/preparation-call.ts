/** Data-only named preparation protocol. No renderer, factory, source record,
 * parent identity or caller authority is accepted by the authored request. */
import { assertJsonValue } from "../json.ts";

export type ActionNamedPreparation = Readonly<{
  preparation: string;
  recordId: string;
  mode: string;
}>;
export type ActionPrepareNamedOptions = Readonly<{
  operationKey: string;
  signal?: AbortSignal;
}>;
function invalid(): never {
  throw new TypeError(
    "Named Action preparation requires exact data and an explicit operationKey.",
  );
}
function text(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) invalid();
  return value;
}
function data(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length) invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(properties).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(properties, key))
  ) invalid();
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(properties)) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    output[key] = descriptor.value;
  }
  return output;
}
/** Pure authored-call validation; the placement driver supplies the target and
 * parent binding separately. No implicit operation index is allocated here. */
export function normalizeActionNamedPreparation(
  request: unknown,
  options: unknown,
): Readonly<{
  request: ActionNamedPreparation;
  operationKey: string;
  signal?: AbortSignal;
}> {
  const input = data(request, ["preparation", "recordId", "mode"], [
    "preparation",
    "recordId",
    "mode",
  ]);
  assertJsonValue(input, { maxDepth: 2, maxNodes: 4 });
  const args = data(options, ["operationKey", "signal"], ["operationKey"]);
  if (typeof args.operationKey !== "string") invalid();
  const operationKey = text(args.operationKey.trim());
  const signal = args.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  return Object.freeze({
    request: Object.freeze({
      preparation: text(input.preparation),
      recordId: text(input.recordId),
      mode: text(input.mode),
    }),
    operationKey,
    ...(args.signal === undefined
      ? {}
      : { signal: args.signal as AbortSignal }),
  });
}
