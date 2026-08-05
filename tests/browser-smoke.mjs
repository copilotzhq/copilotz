import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const bundle = process.argv[2];
if (!bundle) throw new Error("Browser smoke requires a bundle path.");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>Copilotz runtime smoke</title>");
  await page.addScriptTag({
    type: "module",
    content: await readFile(bundle, "utf8"),
  });
  const handle = await page.waitForFunction(() =>
    globalThis.__copilotzRuntimeSmoke
  );
  const result = await handle.jsonValue();
  if (
    JSON.stringify(result) !== JSON.stringify({
      plugin: "smoke.plugin",
      processor: "smoke.processor",
      bytes: [2, 3, 4],
    })
  ) {
    throw new Error(
      `Unexpected browser smoke result: ${JSON.stringify(result)}`,
    );
  }
  console.log(`copilotz-browser-smoke:${JSON.stringify(result)}`);
} finally {
  await browser.close();
}
