/**
 * Cloud computers' web front end, for the browser: a kind of computer in
 * computers' pages (their `computerKinds` resource). Where people add a
 * computer to a space, "Use a cloud computer" comes first: its sizes as
 * cards, with what an hour awake costs (as people pay), and a name
 * (`cloud.create`); refused, it says who can. Wherever one shows (a space's
 * computers, its page's header), its state: Awake, Asleep, Sleeping deeply,
 * Waking…, Going to sleep…; on its page, its size and disk, and while it's
 * awake, for how long and about what that came to. Asleep, in place of its
 * terminal, jobs and files, waking it (opening its page wakes it), with
 * honest progress. It's deleted, disk and all, from its page's menu, asked
 * first (`cloud.destroy`). Add it beside computers' front end:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb, cloudWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { cloudComputerView } from "./views/web/computer.tsx";
import { cloudNewView } from "./views/web/new.tsx";

export const cloudWeb: Plugin = definePlugin({
  name: "cloud-web",
  requires: ["cloud", "computers-web"],
  views: {
    "cloud.computer": { web: cloudComputerView },
    "cloud.new": { web: cloudNewView },
  },
  resources: {
    computerKinds: {
      cloud: {
        title: "Cloud computer",
        icon: "server",
        mine: "cloudComputer.mine",
        view: "cloud.computer",
        add: {
          view: "cloud.new",
          title: "Use a cloud computer",
          description: "Ready in seconds, with nothing to install. It sleeps when it isn't " +
            "used, and you pay only while it's awake.",
          heading: "New cloud computer",
        },
        remove: {
          action: "cloud.destroy",
          label: "Delete this computer",
          title: "Delete {name}?",
          text: "Its disk is deleted, with every space's folder on it and the jobs it keeps, and " +
            "agents can't use it any more. This can't be undone.",
          button: "Delete it",
        },
        order: 10,
      },
    },
  },
});
