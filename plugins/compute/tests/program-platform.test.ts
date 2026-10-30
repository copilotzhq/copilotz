/**
 * The computer program on each system, as far as one machine can check it:
 * the shell it runs (bash; PowerShell on Windows), where it finds Chrome or
 * Edge, how it's kept running at login (launchd, systemd, Task Scheduler),
 * one running per state, and its releases: their binaries' names, which is
 * newer, and the line that installs one.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { tempDir, test } from "../../../testing/mod.ts";
import { findChrome } from "../computers/program/browser/chrome.ts";
import {
  binaryFor,
  binaryName,
  installCommand,
  newer,
  PLATFORMS,
} from "../computers/program/release.ts";
import { serviceOf } from "../computers/program/service.ts";
import { holdState } from "../computers/program/state.ts";
import { commandArgs, findShell, shellArgs } from "../computers/program/workloads/shell.ts";

/** An empty file at `path` that can be run, its folders made. */
function touch(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "", { mode: 0o755 });
}

test("bash on macOS and Linux; on Windows, PowerShell 7 when it's there, else 5.1", async () => {
  const dir = tempDir();
  touch(join(dir, "bash"));
  assertEquals(await findShell("linux", { PATH: dir }), { kind: "bash", path: join(dir, "bash") });
  assertEquals(await findShell("darwin", { PATH: "" }), { kind: "bash", path: "/bin/bash" });
  const windows = await findShell("win32", { PATH: dir, SystemRoot: "C:\\Windows" });
  assertEquals(windows.kind, "powershell");
  assertMatch(windows.path, /WindowsPowerShell.v1\.0.powershell\.exe$/);
  touch(join(dir, "pwsh.exe"));
  assertEquals(await findShell("win32", { PATH: dir }), {
    kind: "powershell",
    path: join(dir, "pwsh.exe"),
  });
});

test("PowerShell gets its commands whole (encoded), never quoted by Windows' rules", () => {
  const pwsh = { kind: "powershell" as const, path: "pwsh" };
  const decode = (args: string[]) => {
    assertEquals(args.slice(0, 3), ["-NoLogo", "-NoProfile", "-EncodedCommand"]);
    const bytes = Uint8Array.from(atob(args[3]), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-16le").decode(bytes);
  };
  const job = decode(commandArgs(pwsh, `echo "it's" | Out-Host`));
  assertStringIncludes(job, `'echo "it''s" | Out-Host'`);
  assertStringIncludes(job, "exit $(if ($global:__copilotz_ok)");
  const shell = decode(shellArgs(pwsh, "C:\\Temp\\it's", "abc123"));
  assertStringIncludes(shell, `$__copilotz_dir = 'C:\\Temp\\it''s'`);
  assertStringIncludes(shell, "[Console]::In.ReadLine()");
  assertStringIncludes(shell, "abc123:");
  // bash reads the same ids, and sources each one's script.
  const bash = shellArgs({ kind: "bash", path: "bash" }, "/tmp/it's", "abc123").at(-1)!;
  assertStringIncludes(bash, `source '/tmp/it'\\''s'/"$__copilotz_id.sh"`);
});

test("Chrome, Chromium or Edge, where Windows installs them, for one person or all", async () => {
  const local = tempDir();
  const programs = tempDir();
  const env = { LOCALAPPDATA: local, ProgramFiles: programs, "ProgramFiles(x86)": undefined };
  assertEquals(await findChrome(env, "win32"), null);
  const edge = join(programs, "Microsoft", "Edge", "Application", "msedge.exe");
  touch(edge);
  assertEquals(await findChrome(env, "win32"), edge);
  // Chrome comes first, the person's own before everyone's.
  const chrome = join(local, "Google", "Chrome", "Application", "chrome.exe");
  touch(chrome);
  assertEquals(await findChrome(env, "win32"), chrome);
  assertEquals(await findChrome({ ...env, COPILOTZ_CHROMIUM: edge }, "win32"), edge);
});

test("kept running at login: a launchd agent, a systemd user unit, a scheduled task", () => {
  const env = {
    PATH: "/opt/tools/bin:/usr/bin",
    LANG: "en_US.UTF-8",
    SECRET: "no",
    COPILOTZ_CHROMIUM: "/opt/chrome",
    COPILOTZ_OTHER: "no",
  };
  const mac = serviceOf({
    program: "/Users/ana/.copilotz/bin/computer",
    platform: "darwin",
    env,
    home: "/Users/ana",
  });
  assertEquals(mac.files[0].path, "/Users/ana/Library/LaunchAgents/com.copilotz.computer.plist");
  const plist = mac.files[0].content;
  assertStringIncludes(
    plist,
    "<string>/Users/ana/.copilotz/bin/computer</string><string>run</string>",
  );
  assertStringIncludes(plist, "<key>PATH</key><string>/opt/tools/bin:/usr/bin</string>");
  assertStringIncludes(plist, "<key>COPILOTZ_CHROMIUM</key><string>/opt/chrome</string>");
  assert(
    !plist.includes("SECRET") && !plist.includes("COPILOTZ_OTHER"),
    "only what it needs of the environment goes with it",
  );
  assertStringIncludes(plist, "<key>SuccessfulExit</key><false/>");
  assertEquals(mac.start[0].slice(0, 2), ["launchctl", "bootstrap"]);
  assertMatch(mac.stop[0].join(" "), /^launchctl bootout gui\/\d+\/com\.copilotz\.computer$/);

  const linux = serviceOf({
    program: "/home/ana/.copilotz/bin/computer",
    platform: "linux",
    env,
    home: "/home/ana",
  });
  assertEquals(linux.files[0].path, "/home/ana/.config/systemd/user/copilotz-computer.service");
  assertStringIncludes(linux.files[0].content, 'ExecStart="/home/ana/.copilotz/bin/computer" run');
  assertStringIncludes(linux.files[0].content, 'Environment="PATH=/opt/tools/bin:/usr/bin"');
  assertStringIncludes(linux.files[0].content, "Restart=on-failure");
  assertEquals(linux.start.at(-1), ["systemctl", "--user", "restart", "copilotz-computer.service"]);

  const windows = serviceOf({
    program: "C:\\Users\\O'Neil\\Copilotz\\computer.exe",
    platform: "win32",
    env,
  });
  assertEquals(windows.files, []);
  const [command, ...args] = windows.start[0];
  assertEquals(command, "powershell.exe");
  const script = new TextDecoder("utf-16le").decode(
    Uint8Array.from(atob(args.at(-1)!), (c) => c.charCodeAt(0)),
  );
  assertStringIncludes(script, "Register-ScheduledTask -TaskName 'Copilotz computer' -Force");
  assertStringIncludes(script, "New-ScheduledTaskTrigger -AtLogOn");
  // The program's path, quoted twice over: in the task's command, and in the script.
  assertStringIncludes(script, "& ''C:\\Users\\O''''Neil\\Copilotz\\computer.exe'' run --log");
});

test("one computer runs on a state at a time; one that ended without letting go is taken over", async () => {
  const path = join(tempDir(), "computer.json");
  const release = await holdState(path);
  assertEquals(readFileSync(`${path}.lock`, "utf8"), String(process.pid));
  // Another process holding it (this test's parent, running): refused.
  writeFileSync(`${path}.lock`, String(process.ppid));
  const error = await assertRejects(() => holdState(path));
  assertEquals((error as { code?: string }).code, "running");
  // One that's gone: taken over.
  writeFileSync(`${path}.lock`, String(spawnSync(process.execPath, ["--version"]).pid));
  const again = await holdState(path);
  await again();
  await release();
  assert(!existsSync(`${path}.lock`), "let go of");
});

test("releases: a binary per platform, by name; which version is newer; the line that installs", () => {
  assertEquals(
    PLATFORMS.map(binaryName),
    [
      "copilotz-computer-macos-arm64",
      "copilotz-computer-macos-x64",
      "copilotz-computer-linux-x64",
      "copilotz-computer-linux-arm64",
      "copilotz-computer-windows-x64.exe",
    ],
  );
  const manifest = {
    version: "1.0.0",
    binaries: [{ os: "linux", arch: "x64", file: "f", size: 1, sha256: "0".repeat(64) }],
  };
  assertEquals(binaryFor(manifest, { os: "linux", arch: "x64" })?.file, "f");
  assertEquals(binaryFor(manifest, { os: "linux", arch: "arm64" }), undefined);
  const order = [
    "0.9.9",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta",
    "1.0.0-rc.1",
    "1.0.0-rc.2",
    "1.0.0-rc.10",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  for (let i = 1; i < order.length; i++) {
    assert(newer(order[i], order[i - 1]), `${order[i]} > ${order[i - 1]}`);
    assert(!newer(order[i - 1], order[i]), `${order[i - 1]} < ${order[i]}`);
  }
  assert(!newer("1.0.0", "1.0.0") && !newer("1.0.0+build.2", "1.0.0"), "the same isn't newer");

  const app = "https://app.example.com";
  const own = "https://app.example.com/computer/download/";
  assertEquals(
    installCommand("sh", { app, code: "K7Q-4MZ", base: own }),
    `curl -fsSL ${own}install.sh | sh -s -- ${app} --code K7Q-4MZ`,
  );
  assertEquals(
    installCommand("powershell", { app, code: "K7Q-4MZ", base: own }),
    `& ([scriptblock]::Create((irm ${own}install.ps1))) ${app} -Code K7Q-4MZ`,
  );
  const elsewhere = "https://releases.example.com/v1/";
  assertStringIncludes(
    installCommand("sh", { app, code: "K", base: elsewhere }),
    `--from ${elsewhere}`,
  );
  assertStringIncludes(
    installCommand("powershell", { app, code: "K", base: elsewhere }),
    `-From ${elsewhere}`,
  );
});
