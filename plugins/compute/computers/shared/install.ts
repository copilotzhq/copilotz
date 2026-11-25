/**
 * Each engine's official installer, as its maker gives it (macOS and
 * Linux): what Sign in runs on a computer whose CLI is missing
 * (`computer.engine.login` with `install`), and what the web shows to run
 * by hand. It imports only types, so the web's plans read it too.
 */
import type { EngineName } from "./engines.ts";

export const INSTALL: Record<EngineName, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm i -g @openai/codex",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
};
