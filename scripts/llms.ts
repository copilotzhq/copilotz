/** The package's reading list, in the same order as the website's docs. */
import { readFileSync, writeFileSync } from "node:fs";

export function llmsTxt(): string {
  const manifest: {
    sections: { title: string; items: { title: string; slug: string; description: string }[] }[];
  } = JSON.parse(readFileSync(new URL("../docs/manifest.json", import.meta.url), "utf8"));
  const lines = [
    "# Copilotz",
    "",
    "> Build business apps that people and agents use through the same Actions, data and rules.",
    "",
    "## Start here",
    "",
    "- [AGENTS.md](AGENTS.md): Start an app and write a plugin, from its data to its tests.",
    "- [Find it](AGENTS.md#find-it-what-an-app-needs-and-where-its-documented): Find an API by the job it does.",
    "",
  ];
  for (const { title, items } of manifest.sections) {
    lines.push(`## ${title}`, "");
    for (const page of items) {
      lines.push(`- [${page.title}](docs/${page.slug}.md): ${page.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) writeFileSync(new URL("../llms.txt", import.meta.url), llmsTxt());
