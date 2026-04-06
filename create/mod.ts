// deno-lint-ignore-file no-console
import { join, resolve } from "@std/path";

const TEMPLATE_REPO = "copilotzhq/starter";
const TEMPLATE_BRANCH = "main";

const encoder = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function printBanner() {
  console.log(`
  ${bold("Copilotz Starter")}
  ${dim("Create a new Copilotz project")}
`);
}

function printHelp() {
  printBanner();
  console.log(`  ${bold("USAGE:")}
    ${dim("deno run -Ar jsr:@copilotz/copilotz/create <project-name> [options]")}
    ${dim("deno create @copilotz/copilotz <project-name> [options]")}

  ${bold("OPTIONS:")}
    ${cyan("--force, -f")}   Overwrite existing directory
    ${cyan("--help, -h")}    Show this help message
`);
}

function parseArgs(
  args: string[],
): { projectName?: string; force: boolean; help: boolean } {
  let projectName: string | undefined;
  let force = false;
  let help = false;

  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (!arg.startsWith("-")) {
      projectName = arg;
    }
  }

  return { projectName, force, help };
}

async function downloadAndExtract(
  projectDir: string,
): Promise<void> {
  const tarballUrl =
    `https://api.github.com/repos/${TEMPLATE_REPO}/tarball/${TEMPLATE_BRANCH}`;
  const tempDir = await Deno.makeTempDir();
  const tarballPath = join(tempDir, "template.tar.gz");

  try {
    const response = await fetch(tarballUrl, {
      headers: { "Accept": "application/vnd.github+json" },
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to download template: ${response.status} ${response.statusText}`,
      );
    }

    const file = await Deno.open(tarballPath, { write: true, create: true });
    await response.body.pipeTo(file.writable);

    await Deno.mkdir(projectDir, { recursive: true });

    const extract = new Deno.Command("tar", {
      args: ["xzf", tarballPath, "--strip-components=1", "-C", projectDir],
    });
    const result = await extract.output();

    if (!result.success) {
      throw new Error("Failed to extract template archive");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

async function patchDenoJson(
  projectDir: string,
  projectName: string,
): Promise<void> {
  const filePath = join(projectDir, "deno.json");
  const content = JSON.parse(await Deno.readTextFile(filePath));
  content.name = `@my-scope/${projectName}`;
  content.description = `${projectName} - Built with Copilotz`;
  await Deno.writeTextFile(filePath, JSON.stringify(content, null, 2) + "\n");
}

async function patchWebPackageJson(
  projectDir: string,
  projectName: string,
): Promise<void> {
  const filePath = join(projectDir, "web", "package.json");
  try {
    const content = JSON.parse(await Deno.readTextFile(filePath));
    content.name = `${projectName}-web`;
    await Deno.writeTextFile(
      filePath,
      JSON.stringify(content, null, 2) + "\n",
    );
  } catch {
    // web/package.json may not exist in all template versions
  }
}

async function createEnvFile(projectDir: string): Promise<void> {
  const examplePath = join(projectDir, ".env.example");
  const envPath = join(projectDir, ".env");
  try {
    await Deno.copyFile(examplePath, envPath);
  } catch {
    // .env.example may not exist
  }
}

async function removeLockfile(projectDir: string): Promise<void> {
  try {
    await Deno.remove(join(projectDir, "deno.lock"));
  } catch {
    // ok if it doesn't exist
  }
}

async function gitInit(projectDir: string): Promise<boolean> {
  try {
    const init = new Deno.Command("git", {
      args: ["init"],
      cwd: projectDir,
      stdout: "null",
      stderr: "null",
    });
    const initResult = await init.output();
    if (!initResult.success) return false;

    const add = new Deno.Command("git", {
      args: ["add", "."],
      cwd: projectDir,
      stdout: "null",
      stderr: "null",
    });
    await add.output();

    const commit = new Deno.Command("git", {
      args: ["commit", "-m", "Initial commit from copilotz starter"],
      cwd: projectDir,
      stdout: "null",
      stderr: "null",
    });
    await commit.output();

    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { projectName: rawName, force, help } = parseArgs(Deno.args);

  if (help) {
    printHelp();
    return;
  }

  printBanner();

  let projectName = rawName;

  if (!projectName) {
    const input = prompt("  Project name:");
    if (!input?.trim()) {
      console.error(`\n  ${red("Error:")} Project name is required.\n`);
      Deno.exit(1);
    }
    projectName = input.trim();
  }

  const projectDir = resolve(projectName);

  try {
    const stat = await Deno.stat(projectDir);
    if (stat.isDirectory) {
      if (!force) {
        console.error(
          `\n  ${red("Error:")} Directory ${bold(projectName)} already exists.`,
        );
        console.error(`  Use ${cyan("--force")} to overwrite.\n`);
        Deno.exit(1);
      }
      await Deno.remove(projectDir, { recursive: true });
    }
  } catch {
    // directory doesn't exist -- good
  }

  console.log(`  Creating ${bold(projectName)}...\n`);

  write("  Downloading template... ");
  await downloadAndExtract(projectDir);
  console.log(green("done"));

  write("  Patching project files... ");
  await patchDenoJson(projectDir, projectName);
  await patchWebPackageJson(projectDir, projectName);
  await createEnvFile(projectDir);
  await removeLockfile(projectDir);
  console.log(green("done"));

  write("  Initializing git... ");
  const gitOk = await gitInit(projectDir);
  console.log(gitOk ? green("done") : dim("skipped (git not available)"));

  console.log(`
  ${green("Done!")} Your project is ready.

  ${dim("$")} cd ${projectName}
  ${dim("$")} ${dim("# Edit .env with your API keys")}
  ${dim("$")} deno task dev ${dim("          # start the API server")}
  ${dim("$")} deno task dev:web ${dim("      # start the web UI (separate terminal)")}
`);
}

if (import.meta.main) {
  main();
}
