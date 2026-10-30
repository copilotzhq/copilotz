/// <reference lib="dom" />
/**
 * The terminal agent in a browser, as another brand, "Harbor": the same
 * front ends, and one `theme` resource (brands.ts: its colours, fonts and
 * logo). Rebranding is data; nothing else changes. Served by
 * `BRAND=harbor deno task web`.
 */
import { web } from "../../hosts/web/mod.ts";
import { harbor } from "./brands.ts";
import { front, start } from "./front.ts";

await web({ root: document.getElementById("app")!, plugins: [...front, harbor], start });
