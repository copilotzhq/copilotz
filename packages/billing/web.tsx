/**
 * Billing's front end, for the browser (`@copilotz/billing/web`): `creditsWeb`,
 * the org page's Billing section (balance, plan, budget, history; paying, for
 * those who run the org) and the note above where you type when the org is
 * low or stopped. Add it beside the web shell's:
 *
 * ```ts
 * import { creditsWeb } from "@copilotz/billing/web";
 *
 * await web({ plugins: [webShell, chatWeb, spacesWeb, usageWeb, creditsWeb], root });
 * ```
 */
export { creditsWeb } from "./credits/web.tsx";
