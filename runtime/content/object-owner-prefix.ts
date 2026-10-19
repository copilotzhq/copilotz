import { digestContent } from "./digest.ts";
/** Public schema component plus collision-resistant full identity. */
export async function objectBodyRoot(prefix: string): Promise<string> {
  return `bodies/${(await objectIdentityHash(prefix))}/`;
}
export async function objectIdentityHash(value: unknown): Promise<string> {
  return (await digestContent(new TextEncoder().encode(JSON.stringify(value))))
    .slice(7);
}
export function objectOwnerSegment(bodyId: string): string {
  const matches = [
    ...bodyId.matchAll(/(?:^|\/)schemas\/([A-Za-z_][A-Za-z0-9_]*)(?=\/|$)/g),
  ];
  return matches.length
    ? `schemas/${matches[matches.length - 1][1]}/`
    : "unscoped/";
}
export async function objectBodyBase(
  prefix: string,
  bodyId: string,
): Promise<string> {
  return `${await objectBodyRoot(prefix)}${
    objectOwnerSegment(bodyId)
  }${await objectIdentityHash(bodyId)}`;
}
