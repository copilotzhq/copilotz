import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../../index.ts";
import { listen as denoListen } from "../adapters/deno/listen.ts";
import { listen as nodeListen } from "../adapters/node/listen.ts";

for (
  const [runtime, listen] of [["Deno", denoListen], [
    "Node",
    nodeListen,
  ]] as const
) {
  Deno.test(`${runtime} embedded host owns listeners and refuses attachment after close`, async () => {
    const app = await createCopilotz();
    try {
      const first = await listen(app);
      const response = await fetch(first.url);
      assertEquals(response.status, 404);
      await response.body?.cancel();
      await first.shutdown();
      await first.finished;
      const second = await listen(app);
      await app.close();
      await second.finished;
      await assertRejects(async () => await listen(app), TypeError, "closed");
    } finally {
      await app.close();
    }
  });
}
