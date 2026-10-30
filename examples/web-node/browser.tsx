/**
 * The page's code: the web host with the app's front ends, in the default
 * theme, Copilotz's. The person works in their Personal space until they pick
 * another. server.ts bundles it with esbuild.
 */
import { type Client, web } from "../../hosts/web/mod.ts";
import { webShell } from "../../plugins/interfaces/web/mod.ts";
import { chatWeb, memoryWeb, teamWeb } from "../../plugins/agents/web.tsx";
import { spacesWeb } from "../../plugins/access/spaces/web.tsx";

await web({
  root: document.getElementById("app")!,
  plugins: [webShell, chatWeb, spacesWeb, teamWeb, memoryWeb],
  start: async (client: Client) => ({
    space: (await client.call<{ space: string }>("space.personal", {})).space,
  }),
});
