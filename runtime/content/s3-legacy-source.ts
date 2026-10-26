/** Shared physical legacy source reads for the offline importer and reader. */
import type { S3BodyStorageConfig } from "./body-store.ts";
import { bodyInteger } from "./body-store-operations.ts";
import type { S3Requester, S3Response } from "./s3-request.ts";
import { parseStrongEtag } from "./s3-transport.ts";

export function createLegacyS3Source(
  config: S3BodyStorageConfig,
  send: S3Requester,
  invalid: (message: string) => never,
) {
  function generation(value: string | null): string {
    if (
      !value || !/^[1-9][0-9]{0,19}$/.test(value) ||
      BigInt(value) > 18446744073709551615n
    ) invalid("missing exact source generation");
    return value;
  }
  const token = (response: S3Response) =>
    config.provider === "gcs"
      ? `${generation(response.headers.get("x-goog-generation"))}:${
        generation(response.headers.get("x-goog-metageneration"))
      }`
      : parseStrongEtag(response.headers.get("etag")) ??
        invalid("missing exact source ETag");
  const guard = (version: string): Record<string, string> =>
    config.provider === "gcs"
      ? {
        "x-goog-if-generation-match": version.split(":")[0],
        "x-goog-if-metageneration-match": version.split(":")[1],
      }
      : { "if-match": version };
  async function inspect(key: string) {
    const response = await send({
      method: "HEAD",
      objectName: key,
      maxResponseBytes: 0,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) invalid("source object is unavailable");
    const raw = response.headers.get("content-length");
    if (raw === null || !/^\d+$/.test(raw)) invalid("source length is missing");
    return {
      version: token(response),
      response,
      length: bodyInteger(Number(raw)),
    };
  }
  async function read(
    key: string,
    version: string,
    start: number,
    end: number,
    length: number,
  ): Promise<Uint8Array> {
    if (start === end) return new Uint8Array();
    const response = await send({
      method: "GET",
      objectName: key,
      headers: { ...guard(version), range: `bytes=${start}-${end - 1}` },
      maxResponseBytes: end - start,
    });
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !==
        `bytes ${start}-${end - 1}/${length}` ||
      response.bytes.length !== end - start || token(response) !== version
    ) invalid("source changed or returned a short/transformed range");
    return response.bytes;
  }
  return { token, guard, inspect, read };
}
