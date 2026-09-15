import { assert, assertEquals } from "@std/assert";
import { generate } from "../build/index.ts";
import { validateConcretePlugin } from "./check-plugin-layout.ts";

Deno.test("plugin layout verifies generated ownership and detects drift", async () => {
  const directory = await Deno.makeTempDir();
  const plugins = new URL(`file://${directory}/`);
  const root = new URL("example/", plugins);
  try {
    await Deno.mkdir(new URL("actions/run/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("copilotz.json", root),
      JSON.stringify({ id: "example", version: "1" }),
    );
    for (const file of ["README.md", "index.ts", "plugin.ts"]) {
      await Deno.writeTextFile(new URL(file, root), "");
    }
    await Deno.writeTextFile(
      new URL("actions/run/index.ts", root),
      'const action=defineAction({id:"run",execute(){}});export default action;',
    );
    await Deno.writeTextFile(
      new URL("plugin.generated.ts", root),
      await generate(root.pathname),
    );
    assertEquals(await validateConcretePlugin(plugins, "example"), []);
    await Deno.writeTextFile(
      new URL("plugin.generated.ts", root),
      "export default {};",
    );
    assert(
      (await validateConcretePlugin(plugins, "example")).some((x) =>
        x.includes("stale")
      ),
    );
    await Deno.writeTextFile(
      new URL("actions/run/index.ts", root),
      'export {default} from "elsewhere";',
    );
    assert(
      (await validateConcretePlugin(plugins, "example")).some((x) =>
        x.includes("must own")
      ),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
