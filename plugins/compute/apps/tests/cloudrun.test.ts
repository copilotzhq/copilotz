/**
 * The Cloud Run host, against fake Cloud Storage, Cloud Build, Cloud Run
 * (with its operations) and Cloud Monitoring servers: what it asks each,
 * how it waits for builds and operations, and how a folder's Dockerfile
 * chooses how it's built.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { serve, test } from "../../../../testing/mod.ts";
import { cloudRun, cloudRunHost } from "../adapters/cloudrun.ts";
import { settingsOf } from "../shared/settings.ts";
import { streamOf, tgz } from "./tgz.ts";

type Seen = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
};

/** One fake Google API: what it was asked, answered by `answer`. */
async function fake(answer: (seen: Seen, raw: Uint8Array) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = await serve(async (request) => {
    const url = new URL(request.url);
    const raw = new Uint8Array(await request.arrayBuffer());
    const one = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body: new TextDecoder().decode(raw),
    };
    seen.push(one);
    return await answer(one, raw);
  });
  return { ...server, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/**
 * Google's four APIs, faked: a build that's WORKING once, then ends as
 * `ends`. Cloud Storage keeps only half of the second chunk it's sent, once,
 * as it may.
 */
async function google(options: { ends?: string } = {}) {
  const uploaded: Uint8Array[] = [];
  let kept = 0;
  let puts = 0;
  const storage = await fake((seen, raw) => {
    if (seen.method === "POST") {
      kept = puts = 0;
      uploaded.length = 0;
      return new Response(null, {
        status: 200,
        headers: { location: `${storage.url}/upload/session/s1` },
      });
    }
    const range = seen.headers.get("content-range")!;
    const from = Number(/^bytes (\d+)-/.exec(range)?.[1] ?? kept);
    if (from !== kept) return json({ error: { message: "out of order" } }, 400);
    const keeping = ++puts === 2 ? raw.subarray(0, raw.length / 2) : raw;
    uploaded.push(keeping);
    kept += keeping.length;
    return range.endsWith("/*") || keeping.length < raw.length
      ? new Response(null, { status: 308, headers: { range: `bytes=0-${kept - 1}` } })
      : json({ name: "src", bucket: "p-cz-apps" });
  });
  let polls = 0;
  const cloudbuild = await fake((seen) => {
    if (seen.method === "POST") {
      return json({ name: "operations/build/p/b1", metadata: { build: { id: "b1" } } });
    }
    polls++;
    return polls === 1 ? json({ id: "b1", status: "WORKING" }) : json({
      id: "b1",
      status: options.ends ?? "SUCCESS",
      statusDetail: options.ends ? "step 0 failed" : undefined,
      logUrl: "https://console.cloud.google.com/build/b1",
      startTime: "2026-10-30T10:00:00Z",
      finishTime: "2026-10-30T10:01:30Z",
    });
  });
  const services = new Set<string>();
  let operations = 0;
  const run = await fake((seen) => {
    const services$ = "/v2/projects/p/locations/us-central1/services";
    if (seen.path.includes("/operations/")) {
      // Each operation is done the second time it's asked about.
      return json({ name: seen.path.slice(4), done: true });
    }
    if (seen.method === "POST" && seen.path === services$) {
      services.add(seen.query.get("serviceId")!);
      return json({ name: `projects/p/locations/us-central1/operations/o${++operations}` });
    }
    const name = seen.path.slice(services$.length + 1);
    if (seen.method === "GET") {
      return services.has(name)
        ? json({
          name: `projects/p/locations/us-central1/services/${name}`,
          uri: `https://${name}-xyz-uc.a.run.app`,
          latestReadyRevision:
            `projects/p/locations/us-central1/services/${name}/revisions/${name}-0000${operations}-abc`,
        })
        : json({ error: { code: 404, message: "not found" } }, 404);
    }
    if (seen.method === "PATCH") {
      return json({ name: `projects/p/locations/us-central1/operations/o${++operations}` });
    }
    if (seen.method === "DELETE") {
      if (!services.delete(name)) return json({ error: { code: 404 } }, 404);
      return json({
        name: `projects/p/locations/us-central1/operations/o${++operations}`,
        done: true,
      });
    }
    return json({}, 400);
  });
  const monitoring = await fake((seen) => {
    const filter = seen.query.get("filter")!;
    if (filter.includes("billable_instance_time")) {
      return seen.query.get("pageToken")
        ? json({ timeSeries: [{ points: [{ value: { doubleValue: 40 } }] }] })
        : json({
          timeSeries: [{ points: [{ value: { doubleValue: 60 } }] }],
          nextPageToken: "next",
        });
    }
    return json({ timeSeries: [{ points: [{ value: { int64Value: "12" } }] }] });
  });
  const urls = {
    storage: storage.url,
    cloudbuild: cloudbuild.url,
    run: run.url,
    monitoring: monitoring.url,
  };
  return {
    storage,
    cloudbuild,
    run,
    monitoring,
    urls,
    uploaded,
    polls: () => polls,
    close: () =>
      Promise.all([storage.close(), cloudbuild.close(), run.close(), monitoring.close()]),
  };
}

const hostFor = (urls: Record<string, string>) =>
  cloudRunHost({
    project: "p",
    region: "us-central1",
    token: () => Promise.resolve("tok"),
    pollMs: 5,
    chunkBytes: 256,
    urls,
  });

const joined = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) out.set(part, at), at += part.length;
  return out;
};

test("Cloud Run builds a folder without a Dockerfile with buildpacks, uploaded in chunks", async () => {
  const g = await google();
  try {
    // Random bytes don't compress: several chunks of 256 bytes.
    const archive = await tgz({
      "package.json": "{}",
      "public/noise.bin": crypto.getRandomValues(new Uint8Array(2000)),
    });
    const built = await hostFor(g.urls).build({
      app: "shop",
      archive: streamOf(archive, 100),
      command: "npm start",
      port: 3000,
    });
    // The upload: a resumable session, its chunks in order, the last saying the size.
    const [start, ...chunks] = g.storage.seen;
    assertEquals([start.method, start.path, start.query.get("uploadType")], [
      "POST",
      "/upload/storage/v1/b/p-cz-apps/o",
      "resumable",
    ]);
    const object = start.query.get("name")!;
    assertMatch(object, /^src\/shop\/\d{8}-\d{6}-\d{3}\.tgz$/);
    assertEquals(start.headers.get("authorization"), "Bearer tok");
    const whole = Math.floor(archive.length / 256);
    assert(whole > 2, "several chunks");
    const ranges = [];
    for (let i = 0; i < whole; i++) {
      ranges.push(`bytes ${i * 256}-${i * 256 + 255}/*`);
      // Half the second was kept: the other half again.
      if (i === 1) ranges.push(`bytes 384-511/*`);
    }
    ranges.push(
      archive.length % 256
        ? `bytes ${whole * 256}-${archive.length - 1}/${archive.length}`
        : `bytes */${archive.length}`,
    );
    assertEquals(chunks.map((c) => c.headers.get("content-range")), ranges);
    assertEquals(joined(g.uploaded), archive);

    // The build: from that source, with buildpacks, its command the entrypoint.
    const [create] = g.cloudbuild.seen;
    assertEquals([create.method, create.path], ["POST", "/v1/projects/p/builds"]);
    const body = JSON.parse(create.body);
    const stamp = object.slice("src/shop/".length, -".tgz".length);
    const image = `us-central1-docker.pkg.dev/p/cz-apps/shop:${stamp}`;
    assertEquals(body.source, { storageSource: { bucket: "p-cz-apps", object } });
    assertEquals(body.steps, [{
      name: "gcr.io/k8s-skaffold/pack",
      entrypoint: "pack",
      args: [
        "build",
        image,
        "--builder",
        "gcr.io/buildpacks/builder:google-22",
        "--path",
        ".",
        "--publish",
        "--env",
        "GOOGLE_ENTRYPOINT=npm start",
      ],
    }]);
    // Polled until it ended: 90 s are 2 minutes, as Cloud Build bills them.
    assertEquals(g.polls(), 2);
    assertEquals(g.cloudbuild.seen[1].path, "/v1/projects/p/builds/b1");
    assertEquals(built, { image, minutes: 2 });
  } finally {
    await g.close();
  }
});

test("Cloud Run builds a folder with a Dockerfile with it, then pushes; a failed build says why, with its minutes", async () => {
  const g = await google();
  try {
    const archive = await tgz({ "Dockerfile": "FROM node:24\n", "index.js": "" });
    const { image } = await hostFor(g.urls).build({
      app: "api",
      archive: streamOf(archive),
      port: 8080,
    });
    const body = JSON.parse(g.cloudbuild.seen[0].body);
    assertEquals(body.steps, [
      { name: "gcr.io/cloud-builders/docker", args: ["build", "-t", image, "."] },
      { name: "gcr.io/cloud-builders/docker", args: ["push", image] },
    ]);
    assertMatch(image, /^us-central1-docker\.pkg\.dev\/p\/cz-apps\/api:\d{8}-\d{6}-\d{3}$/);
  } finally {
    await g.close();
  }

  const failing = await google({ ends: "FAILURE" });
  try {
    const error = await assertRejects(() =>
      hostFor(failing.urls).build({
        app: "api",
        archive: streamOf(new TextEncoder().encode("not a gzipped tar")),
        port: 8080,
      })
    );
    // What isn't a gzipped tar can't be read as one.
    assertStringIncludes(String(error), "can't be read");
    const archive = await tgz({ "index.js": "" });
    const failed = await assertRejects(() =>
      hostFor(failing.urls).build({ app: "api", archive: streamOf(archive), port: 8080 })
    ) as Error & { minutes: number };
    assertStringIncludes(failed.message, "The build failure: step 0 failed");
    assertStringIncludes(failed.message, "https://console.cloud.google.com/build/b1");
    assertEquals(failed.minutes, 2);
  } finally {
    await failing.close();
  }
});

test("Cloud Run deploys: creates the service, public and scaling to zero, then patches it with a new revision", async () => {
  const g = await google();
  try {
    const host = hostFor(g.urls);
    const first = await host.deploy({ app: "shop", image: "img:1", port: 3000, env: { A: "1" } });
    assertEquals(first, {
      service: "projects/p/locations/us-central1/services/shop",
      target: "https://shop-xyz-uc.a.run.app",
      revision: "shop-00001-abc",
    });
    const [read, create, poll] = g.run.seen;
    assertEquals([read.method, read.path], [
      "GET",
      "/v2/projects/p/locations/us-central1/services/shop",
    ]);
    assertEquals([create.method, create.path, create.query.get("serviceId")], [
      "POST",
      "/v2/projects/p/locations/us-central1/services",
      "shop",
    ]);
    assertEquals(JSON.parse(create.body), {
      labels: { "copilotz-app": "shop", "managed-by": "copilotz" },
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: true,
      template: {
        serviceAccount: "cz-apps@p.iam.gserviceaccount.com",
        scaling: { minInstanceCount: 0, maxInstanceCount: 3 },
        containers: [{
          image: "img:1",
          ports: [{ containerPort: 3000 }],
          env: [{ name: "A", value: "1" }],
          resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
        }],
      },
    });
    // It waited for the operation.
    assertEquals([poll.method, poll.path], [
      "GET",
      "/v2/projects/p/locations/us-central1/operations/o1",
    ]);

    g.run.seen.length = 0;
    const second = await host.deploy({ app: "shop", image: "img:2", port: 3000 });
    assertEquals(second.revision, "shop-00002-abc");
    const patch = g.run.seen.find((s) => s.method === "PATCH")!;
    assertEquals(patch.path, "/v2/projects/p/locations/us-central1/services/shop");
    assertEquals(JSON.parse(patch.body).template.containers[0].image, "img:2");
    assertEquals(g.run.seen.filter((s) => s.method === "POST"), []);

    // Removed; removing again is fine.
    await host.remove("shop");
    await host.remove("shop");
    assertEquals(g.run.seen.filter((s) => s.method === "DELETE").length, 2);
  } finally {
    await g.close();
  }
});

test("Cloud Run's usage sums Monitoring's series: instance seconds by size, and requests", async () => {
  const g = await google();
  try {
    const used = await hostFor(g.urls).usage!(
      "shop",
      "2026-10-29T00:00:00.000Z",
      "2026-10-30T00:00:00.000Z",
    );
    // 100 instance-seconds of 1 vCPU and 512 MiB.
    assertEquals(used, { vcpuSeconds: 100, gibSeconds: 50, requests: 12 });
    const [first] = g.monitoring.seen;
    assertEquals(first.path, "/v3/projects/p/timeSeries");
    assertStringIncludes(first.query.get("filter")!, 'resource.labels.service_name="shop"');
    assertEquals(first.query.get("interval.startTime"), "2026-10-29T00:00:00.000Z");
    assertEquals(first.query.get("aggregation.alignmentPeriod"), "86400s");
    // The second page was asked for.
    assert(g.monitoring.seen.some((s) => s.query.get("pageToken") === "next"));
  } finally {
    await g.close();
  }
});

test("cloudRun makes the host from the apps settings: its bucket, repository and service account", async () => {
  const g = await google();
  try {
    const settings = settingsOf({
      resources: { apps: { host: "cloudrun", cloudrun: { project: "p", region: "us-central1" } } },
    });
    assertEquals(settings.cloudrun, {
      project: "p",
      region: "us-central1",
      repository: "cz-apps",
      bucket: "p-cz-apps",
      serviceAccount: "cz-apps@p.iam.gserviceaccount.com",
    });
    const host = cloudRun({ token: () => "tok", pollMs: 5, urls: g.urls })(settings);
    await host.deploy({ app: "shop", image: "img:1", port: 3000 });
    assertEquals(g.run.seen[0].headers.get("authorization"), "Bearer tok");
  } finally {
    await g.close();
  }
});
