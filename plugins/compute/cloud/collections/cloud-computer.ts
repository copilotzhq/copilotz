/**
 * Cloud computers (`CloudComputer`): a computer whose machine the app keeps,
 * its `_id` the computer's. Its disk, where it is, and how it is: cold (a
 * snapshot), asleep (a disk), waking, awake (on a VM) or releasing. Each
 * person reaches their own (the plugin's guard); an org's admins see them
 * all with `cloud.org`.
 */
import { defineCollection, people } from "../../../../runtime/mod.ts";
import { type CloudComputer, SUBJECTS } from "../contract.ts";
import type { May } from "../shared/may.ts";
import { settingsOf } from "../shared/settings.ts";

const placement = {
  type: "object",
  properties: {
    account: { type: "string" },
    project: { type: "string" },
    zone: { type: "string" },
  },
  required: ["project", "zone"],
} as const;

const cloudComputerSchema = {
  type: "object",
  properties: {
    owner: { type: "string" },
    size: { type: "string" },
    placement,
    disk: { type: "string" },
    diskGb: { type: "number" },
    snapshot: { type: "string" },
    state: { type: "string", enum: ["cold", "asleep", "waking", "awake", "releasing"] },
    vm: { type: "string" },
    used: { type: "string" },
    woke: { type: "string" },
    metered: { type: "string" },
    ready: { type: "boolean" },
    viewed: { type: "string" },
    stored: { type: "string" },
    at: { type: "string" },
  },
  required: ["owner", "size", "placement", "disk", "diskGb", "state", "at"],
} as const;

/** A size people may choose, with what it's charged: per hour, and its storage per GB-month. */
export type Offered = {
  id: string;
  label: string;
  vcpu: number;
  memory: number;
  shared?: boolean;
  /** USD an hour awake; null when nothing prices it (or the app has no usage ledger). */
  hour: number | null;
};

/** What `usage.quote` charges for a use, or null. */
type Quote = { price: number | null };

/** Hours in a month, as storage is priced. */
const MONTH_HOURS = 730;

export const cloudComputer = defineCollection({
  schema: cloudComputerSchema,
  indexes: [["owner"], ["state"]],
  queries: {
    /** The asker's cloud computers, newest first. */
    mine: {
      allow: people,
      run: (computers) => computers.find({}, { sort: { at: -1 } }),
    },
    /**
     * The sizes people choose from, each with its price an hour, and what a
     * new computer's disk is: its GB, and storage's price per GB-month (a
     * disk's, and a snapshot's once it's cold); how long one stays awake
     * unused (`warmMinutes`) and while someone has it open (`viewMinutes`);
     * and whether the asker may make one now (`create`; `why` not: only
     * admins make them here, or this month's budget is spent).
     */
    sizes: {
      allow: people,
      run: async (_computers, _params, ctx) => {
        const set = settingsOf(ctx);
        const quote = (subject: string, quantities: Record<string, number>) =>
          ctx.call<Quote>("usage.quote", { meter: "computer", subject, quantities })
            .then((q) => q.price ?? null, () => null);
        const sizes: Offered[] = await Promise.all(
          Object.entries(set.sizes).map(async ([id, size]) => ({
            id,
            label: size.label,
            vcpu: size.vcpu,
            memory: size.memory,
            ...(size.shared ? { shared: true } : {}),
            hour: await quote(SUBJECTS.vm(id), { seconds: 3600 }),
          })),
        );
        const may = await ctx.call<May>("cloud.may", {}).catch((): May => ({ create: false }));
        return {
          sizes,
          disk: {
            gb: set.diskGb,
            gbMonth: await quote(SUBJECTS.disk, { gbHours: MONTH_HOURS }),
            snapshotGbMonth: await quote(SUBJECTS.snapshot, { gbHours: MONTH_HOURS }),
          },
          warmMinutes: set.warmMinutes,
          viewMinutes: set.viewMinutes,
          ...may,
        };
      },
    },
  },
});

export type { CloudComputer };
