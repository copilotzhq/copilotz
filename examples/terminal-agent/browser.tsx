/// <reference lib="dom" />
/**
 * The terminal agent, in a browser: the web host with the app's front ends
 * (front.ts), in the default theme, Copilotz's. Bundled by web.ts.
 */
import { web } from "../../hosts/web/mod.ts";
import { front, start } from "./front.ts";

await web({ root: document.getElementById("app")!, plugins: front, start });
