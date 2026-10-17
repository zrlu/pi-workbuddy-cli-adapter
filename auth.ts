import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CliCommand {
  command: string;
  args: string[];
  source: string;
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

// The single-file headless bundle shipped inside the WorkBuddy AI desktop app.
const BUNDLED_CLI = join(
  LOCALAPPDATA,
  "Programs",
  "WorkBuddyAI",
  "resources",
  "app.asar.unpacked",
  "cli",
  "dist",
  "codebuddy-lite-wb.mjs",
);

function which(name: string): string | undefined {
  const separators = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(separators)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Resolve how to launch the CodeBuddy/WorkBuddy CLI. Override with WORKBUDDY_CLI
// (a .mjs/.cjs/.js script path is run through the current node, anything else is
// executed directly).
export function locateCli(): CliCommand {
  const override = process.env.WORKBUDDY_CLI?.trim();
  if (override) {
    return /\.(mjs|cjs|js)$/i.test(override)
      ? { command: process.execPath, args: [override], source: "WORKBUDDY_CLI (script)" }
      : { command: override, args: [], source: "WORKBUDDY_CLI" };
  }
  if (existsSync(BUNDLED_CLI)) {
    return { command: process.execPath, args: [BUNDLED_CLI], source: "WorkBuddy AI bundled CLI" };
  }
  const names = process.platform === "win32"
    ? ["codebuddy.cmd", "codebuddy.exe", "cbc.cmd", "cbc.exe"]
    : ["codebuddy", "cbc"];
  for (const name of names) {
    const found = which(name);
    if (found) return { command: found, args: [], source: `PATH (${name})` };
  }
  throw new Error(
    "CodeBuddy/WorkBuddy CLI not found. Install the WorkBuddy AI desktop app or set " +
      "WORKBUDDY_CLI to the path of `codebuddy-lite-wb.mjs` (or a `codebuddy` executable).",
  );
}

// A credential supplied by the environment, if the user chose that route.
export function envCredential(): string | undefined {
  return process.env.CODEBUDDY_AUTH_TOKEN?.trim() || process.env.CODEBUDDY_API_KEY?.trim() || undefined;
}

export const AUTH_HINT =
  "CodeBuddy is not signed in. Run /workbuddy-login in Pi, complete browser sign-in, " +
  "then run /workbuddy-status. The bundled lite CLI has no interactive /login UI. " +
  "Alternatively, supply CODEBUDDY_AUTH_TOKEN or CODEBUDDY_API_KEY " +
  "(and CODEBUDDY_BASE_URL if your endpoint differs).";
