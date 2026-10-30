/** Memory's terminal commands: `/memories` lists what agents remember. */
import { command, type Commands, dim } from "../../../../hosts/terminal/mod.ts";
import type { Memory } from "../collections/memory.ts";

export const commands: Commands = {
  "/memories": command({
    description: "What agents remember (★: always in mind)",
    async run(_, term) {
      const kept = await term.runtime.query<Memory[]>("memory.list", {});
      if (!kept.length) return await term.print(dim("Nothing remembered yet."));
      await term.show("memory", kept);
    },
  }),
};
