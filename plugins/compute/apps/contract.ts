/**
 * Apps' contract (see design/cloud-computers.md, "Apps"): what the apps
 * plugin and its hosts (adapters: Cloud Run, a local one for development and
 * tests) agree on. A published app is what a job serves, built from its
 * folder and run on its own, without its computer.
 */

/** A published app (collection `app`). */
export type App = {
  _id: string;
  /** The space it's from, and who published it. */
  space: string;
  by: string;
  name: string;
  /** Its host's first label: `<label>.<domain>` (`copilotz.app`). */
  label: string;
  /** Where it's built from: a computer's folder (under the space's), and what serves it. */
  source: { computer: string; path?: string; command?: string; port: number };
  status: "building" | "live" | "failed" | "removed";
  /** Its service at the host, the URL the front routes to, and its live revision. */
  service?: string;
  target?: string;
  revision?: string;
  /** Why the last build or deploy failed. */
  error?: string;
  at: string;
};

/** Builds and runs apps (resource `appHost`'s adapter). */
export type AppHost = {
  /**
   * Builds an image from a folder (`archive`: a gzipped tar): its Dockerfile,
   * else one made for it running `command`, which serves `port`. Answers the
   * image, the build's minutes (metered), and the port the image serves on
   * when it isn't `port` (one made for it: its front's).
   */
  build(input: {
    app: string;
    archive: ReadableStream<Uint8Array>;
    command?: string;
    port: number;
  }): Promise<{ image: string; minutes: number; port?: number }>;
  /** Runs it (a new revision), scaling to zero; answers its service, URL and revision. */
  deploy(input: {
    app: string;
    image: string;
    port: number;
    env?: Record<string, string>;
  }): Promise<{ service: string; target: string; revision: string }>;
  remove(app: string): Promise<void>;
  /** What it used between two times, for metering (vCPU and GiB seconds, requests). */
  usage?(
    app: string,
    from: string,
    to: string,
  ): Promise<{ vcpuSeconds: number; gibSeconds: number; requests: number }>;
};

/** The usage subjects apps are metered under (meter `app`). */
export const APP_SUBJECTS = { build: "app/build", run: "app/run" } as const;
