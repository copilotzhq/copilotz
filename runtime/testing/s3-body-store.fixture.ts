import { assert } from "@std/assert";
export const s3TestConfig = {
  backendId: "object:test",
  endpoint: "https://objects.example.test",
  bucket: "test-bucket",
  region: "us-east-1",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
};
type ObjectValue = {
  bytes: Uint8Array;
  generation: number;
  etag: string;
  metadata?: Record<string, string>;
};
export function createS3Fixture(gcs = false) {
  const objects = new Map<string, ObjectValue>(), requests: Request[] = [];
  let sequence = 0;
  const gates: Array<
    {
      test: (request: Request) => boolean;
      arrived: () => void;
      hold: Promise<void>;
    }
  > = [];
  const headers = (object: ObjectValue) =>
    new Headers({
      ...object.metadata,
      etag: object.etag,
      "content-length": `${object.bytes.length}`,
      "x-goog-generation": `${object.generation}`,
      "x-goog-metageneration": "1",
    });
  const fetcher: typeof fetch = async (input) => {
    assert(input instanceof Request);
    requests.push(input);
    const gateIndex = gates.findIndex((gate) => gate.test(input));
    if (gateIndex >= 0) {
      const gate = gates.splice(gateIndex, 1)[0];
      gate.arrived();
      await gate.hold;
    }
    const url = new URL(input.url),
      key = decodeURIComponent(url.pathname).replace(/^\/test-bucket\//, "");
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix))
        .sort();
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${
          keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")
        }</ListBucketResult>`,
      );
    }
    const object = objects.get(key),
      match = input.headers.get("if-match"),
      absent = input.headers.get("if-none-match"),
      generation = input.headers.get("x-goog-if-generation-match"),
      meta = input.headers.get("x-goog-if-metageneration-match");
    if (
      match !== null && object?.etag !== match || absent === "*" && object ||
      generation !== null &&
        (generation === "0"
          ? !!object
          : object?.generation !== Number(generation)) ||
      meta !== null && meta !== "1"
    ) return new Response(null, { status: 412 });
    if (input.method === "HEAD") {
      return object
        ? new Response(null, { headers: headers(object) })
        : new Response(null, { status: 404 });
    }
    if (input.method === "GET") {
      if (!object) return new Response(null, { status: 404 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(
        input.headers.get("range") ?? "",
      );
      if (range) {
        const start = Number(range[1]),
          end = Number(range[2]) + 1,
          selected = object.bytes.slice(start, end),
          selectedHeaders = headers(object);
        selectedHeaders.set("content-length", String(selected.length));
        selectedHeaders.set(
          "content-range",
          `bytes ${start}-${end - 1}/${object.bytes.length}`,
        );
        return new Response(selected, {
          status: 206,
          headers: selectedHeaders,
        });
      }
      return new Response(object.bytes.slice(), { headers: headers(object) });
    }
    if (input.method === "PUT") {
      assert(gcs ? generation !== null : match !== null || absent === "*");
      const value = {
        bytes: new Uint8Array(await input.arrayBuffer()),
        generation: ++sequence,
        etag: `"version-${sequence}"`,
      };
      objects.set(key, value);
      return new Response(null, { headers: headers(value) });
    }
    if (input.method === "DELETE") {
      assert(gcs);
      assert(generation !== null && generation !== "0");
      if (!object) return new Response(null, { status: 404 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return {
    objects,
    requests,
    fetch: fetcher,
    hold(test: (request: Request) => boolean) {
      const arrived = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      gates.push({
        test,
        arrived: () => arrived.resolve(),
        hold: release.promise,
      });
      return { arrived: arrived.promise, release: () => release.resolve() };
    },
  };
}
