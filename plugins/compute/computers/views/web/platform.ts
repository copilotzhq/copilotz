/**
 * The visitor's computer, as well as its browser says: its system, as the
 * program's releases name them (`darwin`, `linux`, `win32`), and, when it can
 * tell, its architecture (`arm64`, `x64`). Chromium says both; others say the
 * system, and on a Mac the graphics name Apple silicon. A phone or a tablet
 * is none of them: it's probably not the computer being connected.
 */
import { OS_NAMES } from "../../program/release.ts";

export type System = "darwin" | "linux" | "win32";

export const SYSTEMS = Object.keys(OS_NAMES) as System[];

type Hints = {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
};

/** The system the browser runs on, if it's one the program runs on. */
export function visitorSystem(nav: Navigator = navigator): System | undefined {
  const hints = (nav as Navigator & { userAgentData?: Hints }).userAgentData;
  const said = `${hints?.platform ?? ""} ${nav.platform} ${nav.userAgent}`;
  if (hints?.mobile || /android|iphone|ipad|ipod/i.test(said)) return undefined;
  // An iPad says it's a Mac, but has a touch screen.
  if (/mac/i.test(said)) return nav.maxTouchPoints > 1 ? undefined : "darwin";
  if (/win/i.test(said)) return "win32";
  if (/linux|x11|cros/i.test(said)) return "linux";
}

/** Whether a Mac's graphics are Apple's own (its silicon), when WebGL says. */
function appleGraphics(): boolean | undefined {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    return renderer ? /apple (m\d|gpu)/i.test(renderer) : undefined;
  } catch {
    return undefined;
  }
}

/** The browser's architecture (`arm64`, `x64`), when it can tell. */
export async function visitorArch(nav: Navigator = navigator): Promise<string | undefined> {
  const hints = (nav as Navigator & { userAgentData?: Hints }).userAgentData;
  const said = await hints?.getHighEntropyValues?.(["architecture", "bitness"]).catch(() => {});
  if (said?.architecture) return said.architecture === "arm" ? "arm64" : "x64";
  if (/aarch64|arm64/i.test(nav.userAgent)) return "arm64";
  if (visitorSystem(nav) === "darwin") {
    const apple = appleGraphics();
    return apple === undefined ? undefined : apple ? "arm64" : "x64";
  }
  if (/x86_64|x64|win64|wow64|amd64/i.test(nav.userAgent)) return "x64";
}

/** How people know an architecture, on a system. */
export const archName = (os: string, arch: string): string =>
  os === "darwin"
    ? arch === "arm64" ? "Apple silicon" : "Intel"
    : arch === "arm64"
    ? "Arm (64-bit)"
    : os === "win32"
    ? "64-bit (x64; Windows on Arm runs it too)"
    : "x64 (Intel, AMD)";
