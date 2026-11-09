/**
 * Team's front ends, for the browser (`@copilotz/team/web`): `teamWeb` (an
 * agent's page, making one, adding one to a space, agents in the palette)
 * and `tiersWeb` (the org page's Agents' models, and a space's). Add them
 * beside the web shell's and spaces':
 *
 * ```ts
 * import { teamWeb, tiersWeb } from "@copilotz/team/web";
 *
 * await web({ plugins: [webShell, chatWeb, spacesWeb, teamWeb, tiersWeb], root });
 * ```
 */
export { teamWeb } from "./team/web.tsx";
export { tiersWeb } from "./tiers/web.tsx";
