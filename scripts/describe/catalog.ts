/**
 * Every plugin Copilotz exports, by the layer it ships in (agreed for 1.0):
 *
 * - **standard:** with `copilotz` itself;
 * - **package:** in a product package of its own, in this repository
 *   (`packages/<name>`, `@copilotz/<name>`: see design/plugins.md);
 * - **private:** moving to Compass, so never on the public pages.
 *
 * Plugins are found in the entry points (Copilotz's `deno.json`'s `exports`,
 * and each package's): a plugin no layer names stops the docs from being
 * made, so none goes missing, and one exported where its layer doesn't say
 * (a package's by Copilotz) stops them too. A function that makes a plugin (`openapi`) is described
 * as an example makes it.
 */
import type { Plugin } from "../../runtime/mod.ts";

export type Layer = "standard" | "package" | "private";

export type Placed = {
  layer: Layer;
  /** The package it moves to, for a plugin of the `package` layer. */
  package?: string;
  /** For a function that makes the plugin: how to make one, and what the page says of it. */
  make?: (value: unknown) => Plugin | Promise<Plugin>;
  example?: string;
  /** The name its page goes by, when the example's isn't it (`openapi`, not `trips`). */
  name?: string;
};

const standard: Placed = { layer: "standard" };
const work: Placed = { layer: "package", package: "@copilotz/work" };
const directory: Placed = { layer: "package", package: "@copilotz/directory" };
const billing: Placed = { layer: "package", package: "@copilotz/billing" };
const team: Placed = { layer: "package", package: "@copilotz/team" };
const compass: Placed = { layer: "private" };

/** A small API, for the example `openapi` plugin. */
const TRIPS = {
  openapi: "3.1.0",
  info: { title: "Trips", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v2" }],
  paths: {
    "/trips": {
      get: {
        operationId: "listTrips",
        summary: "Lists the trips that match a search.",
        parameters: [{ name: "to", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "The trips." } },
      },
    },
    "/trips/{tripId}": {
      get: {
        operationId: "getTrip",
        summary: "Reads a trip.",
        parameters: [{ name: "tripId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The trip." } },
      },
    },
  },
};

/** The layer of each export, by the name it's exported as. */
export const LAYERS: Record<string, Placed | "skip"> = {
  // Who people are, and where.
  identity: standard,
  spaces: standard,
  contacts: standard,
  googleSignIn: standard,
  devSignIn: standard,
  emailSignIn: standard,
  email: standard,
  spacesWeb: standard,
  contactsWeb: standard,
  accessTerminal: standard,
  // Ways in.
  api: standard,
  apiWeb: standard,
  webShell: standard,
  webPage: standard,
  terminalPlugin: standard,
  terminalShell: standard,
  webLines: standard,
  mcp: standard,
  whatsapp: standard,
  whatsappWeb: standard,
  voice: standard,
  maintenance: standard,
  // Agents.
  models: standard,
  chat: standard,
  chatWeb: standard,
  chatTerminal: standard,
  history: standard,
  memory: standard,
  memoryWeb: standard,
  memoryTerminal: standard,
  memoryExtraction: standard,
  skills: standard,
  skillsWeb: standard,
  routines: standard,
  routinesWeb: standard,
  webTools: standard,
  openapi: {
    ...standard,
    name: "openapi",
    make: (openapi) =>
      (openapi as (options: { name: string; spec: unknown }) => Plugin)({
        name: "trips",
        spec: TRIPS,
      }),
    example:
      'Its Actions and tools come from your API\'s spec. This page describes `openapi({ name: "trips", spec })` for a spec with 2 operations, `listTrips` and `getTrip`.',
  },
  // Usage.
  usage: standard,
  usagePlugin: standard,
  usageWeb: standard,
  usageTerminal: standard,
  // Packages of their own.
  boards: work,
  boardsWeb: work,
  documents: work,
  documentsWeb: work,
  directory: directory,
  directoryWeb: directory,
  "directory.member": {
    ...directory,
    make: (member) =>
      (member as (dir: unknown, org: unknown) => Plugin)(
        { call: () => Promise.resolve(undefined), describe: () => ({ resources: {} }) },
        { id: "acme", name: "Acme", kind: "team" },
      ),
    example:
      "The directory gives each org's runtime this plugin: `directory.member(dir, org)`. This page describes it for an org named Acme.",
  },
  credits: billing,
  creditsWeb: billing,
  stripe: billing,
  stripeWebhook: billing,
  team: team,
  teamWeb: team,
  tiers: team,
  tiersWeb: team,
  // Moving to Compass.
  computers: compass,
  computersWeb: compass,
  computersTerminal: compass,
  computerDownloads: compass,
  cloud: compass,
  cloudWeb: compass,
  cloudPool: compass,
  remotePool: compass,
  apps: compass,
  appsWeb: compass,
  accounts: compass,
  accountsWeb: compass,
  // A test's helper, not a feature.
  testWho: "skip",
};
