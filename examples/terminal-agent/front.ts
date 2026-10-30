/**
 * The terminal agent's front ends, for the browser: the web shell, the
 * features' web front ends (chat, spaces, team, memory, computers, skills,
 * routines, connected accounts, usage, developer keys, WhatsApp), the app's own
 * Notes tab on a space's page (notes-web.tsx), home's suggestions for what
 * this app's agents do well, and the toolkit's gallery (`/gallery`).
 * The page's code (browser.tsx, or a brand's, harbor.tsx) runs them as the
 * signed-in person, who works in their Personal space until they pick
 * another.
 */
import type { Client } from "../../hosts/web/mod.ts";
import { definePlugin, type Plugins } from "../../runtime/mod.ts";
import { webShell } from "../../plugins/interfaces/web/mod.ts";
import { chatWeb } from "../../plugins/agents/chat/web.tsx";
import { teamWeb } from "../../plugins/agents/team/web.tsx";
import { memoryWeb } from "../../plugins/agents/memory/web.tsx";
import { spacesWeb } from "../../plugins/access/spaces/web.tsx";
import { computersWeb } from "../../plugins/compute/computers/web.tsx";
import { skillsWeb } from "../../plugins/agents/skills/web.tsx";
import { routinesWeb } from "../../plugins/agents/routines/web.tsx";
import { accountsWeb } from "../../plugins/access/accounts/web.tsx";
import { usageWeb } from "../../plugins/billing/usage/web.tsx";
import { apiWeb } from "../../plugins/interfaces/api/web.tsx";
import { whatsappWeb } from "../../plugins/interfaces/whatsapp/web.tsx";
import { gallery } from "./gallery.tsx";
import { notesWeb } from "./notes-web.tsx";

const suggestions = definePlugin({
  name: "terminal-agent-web",
  resources: {
    suggestions: {
      explain: null,
      draft: null,
      dice: "Roll dice for me: a 20-sided one",
      research: "Ask the researcher why the sky is blue",
    },
  },
});

export const front: Plugins = [
  webShell,
  chatWeb,
  spacesWeb,
  teamWeb,
  memoryWeb,
  computersWeb,
  skillsWeb,
  routinesWeb,
  accountsWeb,
  usageWeb,
  apiWeb,
  whatsappWeb,
  notesWeb,
  suggestions,
  gallery,
];

/**
 * Where the person works first: their Personal space. Staff visiting an org
 * that isn't theirs get none made there: they start at home.
 */
export const start = async (client: Client) => {
  const me = await client.call<{ role: string | null; staff: boolean }>("org.me", {});
  if (me.staff && !me.role) return {};
  return { space: (await client.call<{ space: string }>("space.personal", {})).space };
};
