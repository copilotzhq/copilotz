/**
 * Cloud Run as an app host (`AppHost`), over Google's REST APIs with fetch
 * (no SDK), authorized by `token()` (an OAuth access token: the app's
 * shared Google auth gives it).
 *
 * - **build:** the archive is uploaded to Cloud Storage (a resumable upload
 *   in chunks, since its size isn't known until it's sent: memory stays at
 *   one chunk), as `src/<app>/<time>.tgz`, while it's read for a top-level
 *   Dockerfile. A Cloud Build from that source builds the image with it
 *   (`docker build`, then a push), else with Google's buildpacks (`pack
 *   build --publish`, `GOOGLE_ENTRYPOINT` the command when there is one),
 *   into `<region>-docker.pkg.dev/<project>/<repository>/<app>:<time>`. It's
 *   polled until it ends; its minutes come from its start and finish,
 *   rounded up as Cloud Build bills them (a failed build's too, on the
 *   error it throws: `minutes`).
 * - **deploy:** the service (named after the app) is created, or patched
 *   when it's there, with the image as a new revision: public (no invoker
 *   check), all ingress, 0 to `maxInstances` instances, one container with
 *   its port, `cpu` and `memory` (CPU only while serving: request-based
 *   billing), running as `serviceAccount`. Its operation is polled until
 *   done; then its URL and latest ready revision are read.
 * - **remove:** deletes the service (gone already is fine).
 * - **usage:** from Cloud Monitoring, an approximation: the service's
 *   `container/billable_instance_time` (instance-seconds Cloud Run bills,
 *   while serving requests, rounded up per 100 ms) times its configured
 *   vCPU and GiB gives vCPU and GiB seconds; `request_count` gives
 *   requests. Monitoring's samples lag a few minutes, so a span ending now
 *   may miss its last minutes; the next span doesn't pick them up.
 *
 * `cloudRun({ token })` is the same host, made from the apps settings'
 * `cloudrun` (its project, region, repository, bucket and service account).
 */
import type { AppHost } from "../contract.ts";
import type { Settings } from "../shared/settings.ts";
import { hasDockerfile } from "./tar.ts";

export type CloudRunOptions = {
  project: string;
  region: string;
  /** Artifact Registry's Docker repository (`cz-apps`). */
  repository?: string;
  /** Where sources are uploaded (`<project>-cz-apps`). */
  bucket?: string;
  /** What apps run as (`cz-apps@<project>.iam.gserviceaccount.com`). */
  serviceAccount?: string;
  /** What Cloud Build runs as (an email); the project's default when absent. */
  buildServiceAccount?: string;
  /** An OAuth access token for Google's APIs (`cloud-platform` scope), as it's needed. */
  token(): string | Promise<string>;
  /** Instances at most per app (3). */
  maxInstances?: number;
  /** Each instance's CPU and memory, as Cloud Run takes them ("1", "512Mi"). */
  cpu?: string;
  memory?: string;
  /** The buildpacks builder (`gcr.io/buildpacks/builder:google-22`). */
  builder?: string;
  /** How long a build may take, in seconds (1200). */
  buildTimeout?: number;
  /** Between polls of a build or an operation (3 s). */
  pollMs?: number;
  /** Each upload chunk's size: a multiple of 256 KiB (8 MiB). */
  chunkBytes?: number;
  /** Google's APIs' addresses, for tests. */
  urls?: { storage?: string; cloudbuild?: string; run?: string; monitoring?: string };
  fetch?: typeof fetch;
};

/** A Cloud Build's states it doesn't leave. */
const ENDED = new Set(["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);

type Operation = {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  metadata?: { build?: { id?: string } };
};
type Build = {
  id: string;
  status: string;
  statusDetail?: string;
  logUrl?: string;
  startTime?: string;
  finishTime?: string;
};
type Service = { name: string; uri?: string; latestReadyRevision?: string };
type TimeSeries = { points?: { value?: { doubleValue?: number; int64Value?: string } }[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A time as it names an object and tags an image: `20261030-231502-123`. */
const stampOf = (date: Date) =>
  date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "");

/** A Cloud Run service's name for an app: lowercase, a letter first, at most 49 characters. */
export const serviceOf = (app: string): string => {
  const name = app.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "");
  return (name || "app").slice(0, 49).replace(/-+$/, "");
};

/** CPU as a number of vCPUs ("1", "2", "500m"). */
const vcpuOf = (cpu: string) => cpu.endsWith("m") ? Number(cpu.slice(0, -1)) / 1000 : Number(cpu);

/** Memory in GiB ("512Mi", "1Gi", "2G"). */
const gibOf = (memory: string) => {
  const [, amount, unit] = /^([\d.]+)\s*([KMGT]i?)?$/.exec(memory) ?? [];
  const bytes: Record<string, number> = {
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  return (Number(amount) * (unit ? bytes[unit] : 1)) / 2 ** 30;
};

export function cloudRunHost(options: CloudRunOptions): AppHost {
  const { project, region } = options;
  const repository = options.repository ?? "cz-apps";
  const bucket = options.bucket ?? `${project}-cz-apps`;
  const serviceAccount = options.serviceAccount ?? `cz-apps@${project}.iam.gserviceaccount.com`;
  const cpu = options.cpu ?? "1";
  const memory = options.memory ?? "512Mi";
  const pollMs = options.pollMs ?? 3000;
  const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024;
  const fetcher = options.fetch ?? fetch;
  const urls = {
    storage: "https://storage.googleapis.com",
    cloudbuild: "https://cloudbuild.googleapis.com",
    run: "https://run.googleapis.com",
    monitoring: "https://monitoring.googleapis.com",
    ...options.urls,
  };
  const parent = `projects/${project}/locations/${region}`;

  /** A call to one of Google's APIs; with `missing`, a 404 answers null. */
  async function api<T>(
    what: string,
    method: string,
    url: string,
    body?: unknown,
    missing = false,
  ): Promise<T> {
    const response = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${await options.token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return null as T;
    }
    if (!response.ok) throw await failed(what, response);
    const textBody = await response.text();
    return (textBody ? JSON.parse(textBody) : {}) as T;
  }

  /** What Google said went wrong, as an error. */
  async function failed(what: string, response: Response) {
    const said = await response.text().catch(() => "");
    let message = said.slice(0, 500);
    try {
      message = (JSON.parse(said) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Not JSON: as it came.
    }
    return Object.assign(new Error(`${what}: HTTP ${response.status}: ${message}`), {
      code: response.status === 403 ? "forbidden" : "failed",
      status: response.status,
    });
  }

  /**
   * Uploads a stream to `object`, in chunks (a resumable upload): each but
   * the last is `chunkBytes` (a multiple of 256 KiB, as Cloud Storage asks),
   * sent once it's full; the last says the whole size.
   */
  async function upload(stream: ReadableStream<Uint8Array>, object: string) {
    // Held from the start: if the upload fails, the rest of the stream is let go.
    const reader = stream.getReader();
    try {
      await uploading(reader, object);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  }

  async function uploading(reader: ReadableStreamDefaultReader<Uint8Array>, object: string) {
    const start = await fetcher(
      `${urls.storage}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable` +
        `&name=${encodeURIComponent(object)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          "content-type": "application/json",
          "x-upload-content-type": "application/gzip",
        },
        body: JSON.stringify({ name: object, contentType: "application/gzip" }),
      },
    );
    if (!start.ok) throw await failed("Uploading the source", start);
    await start.body?.cancel();
    const session = start.headers.get("location");
    if (!session) throw new Error("Uploading the source: Cloud Storage gave no upload address");
    const send = async (chunk: Uint8Array, from: number, total?: number) => {
      for (let at = 0, tries = 0;; tries++) {
        if (tries === 5) throw new Error("Uploading the source: Cloud Storage didn't keep it");
        const part = chunk.subarray(at);
        const first = from + at;
        const response = await fetcher(session, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${await options.token()}`,
            "content-range": part.length
              ? `bytes ${first}-${first + part.length - 1}/${total ?? "*"}`
              : `bytes */${total}`,
          },
          body: part as BufferSource,
          redirect: "manual",
        });
        if (!response.ok && response.status !== 308) {
          throw await failed("Uploading the source", response);
        }
        await response.body?.cancel().catch(() => {});
        if (total !== undefined && response.ok) return;
        // 308: kept so far (`range`), more to come. It may keep less than it was sent: the rest again.
        const said = /bytes=\d+-(\d+)/.exec(response.headers.get("range") ?? "");
        const kept = said ? Number(said[1]) + 1 : 0;
        if (total === undefined && kept >= from + chunk.length) return;
        at = Math.max(kept - from, 0);
      }
    };
    let pending = new Uint8Array(chunkBytes);
    let filled = 0;
    let sent = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      for (let at = 0; at < next.value.length;) {
        const k = Math.min(chunkBytes - filled, next.value.length - at);
        pending.set(next.value.subarray(at, at + k), filled);
        filled += k;
        at += k;
        if (filled === chunkBytes) {
          await send(pending, sent);
          sent += filled;
          pending = new Uint8Array(chunkBytes);
          filled = 0;
        }
      }
    }
    await send(pending.subarray(0, filled), sent, sent + filled);
  }

  /** Polls a Cloud Run operation until it's done; throws what it failed with. */
  async function done(operation: Operation, what: string) {
    let op = operation;
    while (!op.done) {
      await sleep(pollMs);
      op = await api<Operation>(what, "GET", `${urls.run}/v2/${op.name}`);
    }
    if (op.error) throw new Error(`${what}: ${op.error.message ?? `code ${op.error.code}`}`);
  }

  /** A series' points over a span, summed. */
  async function summed(metric: string, service: string, from: string, to: string) {
    const seconds = Math.max(60, Math.ceil((Date.parse(to) - Date.parse(from)) / 1000));
    let total = 0;
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        filter: `metric.type="${metric}" AND resource.type="cloud_run_revision" AND ` +
          `resource.labels.service_name="${service}" AND resource.labels.location="${region}"`,
        "interval.startTime": from,
        "interval.endTime": to,
        "aggregation.alignmentPeriod": `${seconds}s`,
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await api<{ timeSeries?: TimeSeries[]; nextPageToken?: string }>(
        "Reading the app's use",
        "GET",
        `${urls.monitoring}/v3/projects/${project}/timeSeries?${query}`,
      );
      for (const series of page.timeSeries ?? []) {
        for (const point of series.points ?? []) {
          total += Number(point.value?.doubleValue ?? point.value?.int64Value ?? 0);
        }
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return total;
  }

  return {
    async build({ app, archive, command }) {
      const stamp = stampOf(new Date());
      const object = `src/${app}/${stamp}.tgz`;
      const image = `${region}-docker.pkg.dev/${project}/${repository}/${serviceOf(app)}:${stamp}`;
      // Uploaded and looked through at once: the archive is read only once.
      const [toUpload, toScan] = archive.tee();
      const [uploaded, scanned] = await Promise.allSettled([
        upload(toUpload, object),
        hasDockerfile(toScan),
      ]);
      if (uploaded.status === "rejected") throw uploaded.reason;
      if (scanned.status === "rejected") {
        throw new Error(`The folder's archive can't be read: ${scanned.reason}`);
      }
      const docker = "gcr.io/cloud-builders/docker";
      const steps = scanned.value
        ? [
          { name: docker, args: ["build", "-t", image, "."] },
          { name: docker, args: ["push", image] },
        ]
        : [{
          name: "gcr.io/k8s-skaffold/pack",
          entrypoint: "pack",
          args: [
            "build",
            image,
            "--builder",
            options.builder ?? "gcr.io/buildpacks/builder:google-22",
            "--path",
            ".",
            "--publish",
            ...(command ? ["--env", `GOOGLE_ENTRYPOINT=${command}`] : []),
          ],
        }];
      const operation = await api<Operation>(
        "Starting the build",
        "POST",
        `${urls.cloudbuild}/v1/projects/${project}/builds`,
        {
          source: { storageSource: { bucket, object } },
          steps,
          timeout: `${options.buildTimeout ?? 1200}s`,
          tags: ["copilotz-app", serviceOf(app)],
          ...(options.buildServiceAccount
            ? {
              serviceAccount: `projects/${project}/serviceAccounts/${options.buildServiceAccount}`,
              options: { logging: "CLOUD_LOGGING_ONLY" },
            }
            : {}),
        },
      );
      const id = operation.metadata?.build?.id;
      if (!id) throw new Error("Starting the build: Cloud Build gave no build id");
      let build: Build;
      for (;;) {
        build = await api<Build>(
          "Watching the build",
          "GET",
          `${urls.cloudbuild}/v1/projects/${project}/builds/${id}`,
        );
        if (ENDED.has(build.status)) break;
        await sleep(pollMs);
      }
      const minutes = build.startTime && build.finishTime
        ? Math.max(
          1,
          Math.ceil((Date.parse(build.finishTime) - Date.parse(build.startTime)) / 60_000),
        )
        : 0;
      if (build.status !== "SUCCESS") {
        throw Object.assign(
          new Error(
            `The build ${build.status.toLowerCase().replace("_", " ")}` +
              `${build.statusDetail ? `: ${build.statusDetail}` : ""}` +
              `${build.logUrl ? ` (its log: ${build.logUrl})` : ""}`,
          ),
          { code: "build_failed", minutes },
        );
      }
      return { image, minutes };
    },

    async deploy({ app, image, port, env }) {
      const service = serviceOf(app);
      const name = `${parent}/services/${service}`;
      const spec = {
        labels: { "copilotz-app": service, "managed-by": "copilotz" },
        ingress: "INGRESS_TRAFFIC_ALL",
        invokerIamDisabled: true,
        template: {
          serviceAccount,
          scaling: { minInstanceCount: 0, maxInstanceCount: options.maxInstances ?? 3 },
          containers: [{
            image,
            ports: [{ containerPort: port }],
            ...(env && Object.keys(env).length
              ? { env: Object.entries(env).map(([name, value]) => ({ name, value })) }
              : {}),
            resources: { limits: { cpu, memory }, cpuIdle: true },
          }],
        },
      };
      const had = await api<Service | null>(
        "Reading the service",
        "GET",
        `${urls.run}/v2/${name}`,
        undefined,
        true,
      );
      const operation = had
        ? await api<Operation>("Updating the service", "PATCH", `${urls.run}/v2/${name}`, spec)
        : await api<Operation>(
          "Creating the service",
          "POST",
          `${urls.run}/v2/${parent}/services?serviceId=${service}`,
          spec,
        );
      await done(operation, "Deploying");
      const ready = await api<Service>("Reading the service", "GET", `${urls.run}/v2/${name}`);
      if (!ready.uri) throw new Error("Deploying: the service has no URL");
      return {
        service: name,
        target: ready.uri,
        revision: ready.latestReadyRevision?.split("/").pop() ?? "",
      };
    },

    async remove(app) {
      const operation = await api<Operation | null>(
        "Removing the service",
        "DELETE",
        `${urls.run}/v2/${parent}/services/${serviceOf(app)}`,
        undefined,
        true,
      );
      if (operation) await done(operation, "Removing the service");
    },

    async usage(app, from, to) {
      const service = serviceOf(app);
      const [seconds, requests] = await Promise.all([
        summed("run.googleapis.com/container/billable_instance_time", service, from, to),
        summed("run.googleapis.com/request_count", service, from, to),
      ]);
      return {
        vcpuSeconds: seconds * vcpuOf(cpu),
        gibSeconds: seconds * gibOf(memory),
        requests,
      };
    },
  };
}

/**
 * Cloud Run made from the apps settings' `cloudrun` (an `appHost` adapter):
 * `adapters: { appHost: { cloudrun: cloudRun({ token }) } }`. `more` sets
 * what the settings don't (sizes, the build's service account) or replaces
 * what they do.
 */
export const cloudRun = (
  more: Partial<CloudRunOptions> & Pick<CloudRunOptions, "token">,
) =>
(settings: Settings): AppHost => {
  if (!settings.cloudrun && !(more.project && more.region)) {
    throw new Error("Cloud Run needs the apps settings' cloudrun: its project and region.");
  }
  return cloudRunHost({ ...settings.cloudrun, ...more } as CloudRunOptions);
};
