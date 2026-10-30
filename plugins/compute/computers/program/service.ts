/**
 * Starting the computer at login and keeping it running, as its person
 * (`computer install`, undone by `computer uninstall`): a launchd agent on
 * macOS, a systemd user unit on Linux, a scheduled task at logon on Windows,
 * each running `computer run` and starting it again if it fails. What it
 * needs of the environment it's installed from goes with it: the PATH (so
 * agents' commands find the person's tools), the language, and the
 * program's own `COPILOTZ_*` settings. Installing again replaces it, and
 * starts it again (as the binary is now); uninstalling what isn't there is
 * fine.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { ownFolder } from "./state.ts";

/** How it's kept running on a platform. */
export type Service = {
  /** What runs it, said to its person. */
  kind: string;
  /** The files it's made of, and the folders it needs. */
  files: { path: string; content: string }[];
  folders: string[];
  /** What starts it once its files are there, and stops it before they go (failing is fine). */
  start: string[][];
  stop: string[][];
  /** Where what it says goes, said to its person. */
  logs: string;
};

export type ServiceOptions = {
  /** The program to run. */
  program: string;
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
};

/** Where the program is kept for its person: `~/.copilotz/bin`, or `%LOCALAPPDATA%\Copilotz\bin`. */
export const installedPath = (platform: string = process.platform): string =>
  platform === "win32"
    ? join(ownFolder(), "bin", "computer.exe")
    : join(homedir(), ".copilotz", "bin", "computer");

const LABEL = "com.copilotz.computer";
const UNIT = "copilotz-computer.service";
const TASK = "Copilotz computer";

/** What of the environment goes with it: the PATH, the language, the program's own settings. */
const CARRIED = [
  "PATH",
  "LANG",
  "LC_ALL",
  "COPILOTZ_COMPUTER_STATE",
  "COPILOTZ_CHROMIUM",
  "COPILOTZ_BROWSER_WINDOWS",
  "COPILOTZ_SEARCH_URL",
];
const carried = (env: Record<string, string | undefined>) =>
  CARRIED.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!] as const]);

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A value for systemd: quoted, its specifiers escaped. */
const unitQuote = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/** Single quotes for PowerShell. */
const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** PowerShell, running `script` whole. */
const powershell = (script: string) => [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];

/** How this platform keeps the program running (see above). */
export function serviceOf(options: ServiceOptions): Service {
  const { program } = options;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const log = join(home, "Library", "Logs", "Copilotz", "computer.log");
    const domain = `gui/${process.getuid!()}`;
    return {
      kind: "launchd",
      files: [{
        path: plist,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(program)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${
          carried(env).map(([key, value]) =>
            `    <key>${xml(key)}</key><string>${xml(value)}</string>`
          ).join("\n")
        }
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
      }],
      folders: [dirname(log)],
      start: [["launchctl", "bootstrap", domain, plist]],
      stop: [["launchctl", "bootout", `${domain}/${LABEL}`]],
      logs: log,
    };
  }
  if (platform === "win32") {
    const log = join(ownFolder(), "computer.log");
    const run = `& ${psQuote(program)} run --log ${psQuote(log)}; exit $LASTEXITCODE`;
    const stopping = [
      `Stop-ScheduledTask -TaskName ${psQuote(TASK)} -ErrorAction SilentlyContinue`,
      // Ending a task can leave what it started: the program goes too, and any of it renamed aside
      // by an update (not this one, installing).
      `Get-Process | Where-Object { $_.Id -ne ${process.pid} -and $_.Path -and ` +
      `$_.Path.StartsWith(${psQuote(program)}, 'OrdinalIgnoreCase') } | ` +
      "ForEach-Object { taskkill.exe /T /F /PID $_.Id | Out-Null }",
    ];
    return {
      kind: "Task Scheduler",
      files: [],
      folders: [dirname(log)],
      start: [powershell([
        "$ErrorActionPreference = 'Stop'",
        '$user = "$env:USERDOMAIN\\$env:USERNAME"',
        ...stopping,
        `Register-ScheduledTask -TaskName ${psQuote(TASK)} -Force ` +
        "-Description 'Lets an app''s agents work on this computer (Copilotz).' " +
        "-Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument " +
        `${psQuote(`-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "${run}"`)}) ` +
        "-Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) " +
        "-Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) " +
        "-Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
        "-StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) " +
        "-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)) | Out-Null",
        `Start-ScheduledTask -TaskName ${psQuote(TASK)}`,
      ].join("\n"))],
      stop: [powershell([
        ...stopping,
        `Unregister-ScheduledTask -TaskName ${
          psQuote(TASK)
        } -Confirm:$false -ErrorAction SilentlyContinue`,
      ].join("\n"))],
      logs: log,
    };
  }
  const unit = join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", UNIT);
  return {
    kind: "systemd",
    files: [{
      path: unit,
      content: `[Unit]
Description=Copilotz computer: lets an app's agents work on this computer

[Service]
ExecStart=${unitQuote(program)} run
${carried(env).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`,
    }],
    folders: [],
    start: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", UNIT],
      ["systemctl", "--user", "restart", UNIT],
    ],
    stop: [["systemctl", "--user", "disable", "--now", UNIT]],
    logs: `journalctl --user -u ${UNIT}`,
  };
}

/** Runs a command; fails with what it said. */
const exec = ([command, ...args]: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _out, err) => {
      if (!error) return resolve();
      reject(new Error(`${command} ${args[0] ?? ""} failed: ${(err || error.message).trim()}`));
    });
  });

/** Installs `service` (again: replacing it, and starting it as it is now). */
export async function installService(service: Service) {
  for (const command of service.stop) await exec(command).catch(() => {});
  for (const folder of service.folders) await mkdir(folder, { recursive: true });
  for (const { path, content } of service.files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  for (const command of service.start) {
    // What was just stopped can take a moment to be gone (launchd's bootout).
    for (let tries = 1;; tries++) {
      try {
        await exec(command);
        break;
      } catch (error) {
        if (tries === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * tries));
      }
    }
  }
}

/** Uninstalls `service`; false when there was nothing to remove (its logs stay). */
export async function uninstallService(service: Service): Promise<boolean> {
  let removed = false;
  for (const command of service.stop) await exec(command).then(() => removed = true, () => {});
  for (const { path } of service.files) await rm(path).then(() => removed = true, () => {});
  return removed;
}
