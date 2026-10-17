import { spawn, execFile } from "node:child_process";
import { locateCli } from "./auth";
import { cliEnvironment } from "./cli-env.mjs";

export interface CodeBuddyResult {
  parts: any[];
  usage: any;
  finalText?: string;
}

// Drive the CodeBuddy/WorkBuddy CLI headlessly for one turn. The prompt is written
// to stdin (positional prompts hit the Windows command-line length limit once a
// transcript grows), stdout is parsed as newline-delimited JSON, and every parsed
// object is handed to `onEvent`. Resolves with the reconciled assistant content and
// token usage from the terminal `result` record.
export function runCodeBuddy(
  args: string[],
  prompt: string,
  onEvent: (event: any) => void,
  signal?: AbortSignal,
): Promise<CodeBuddyResult> {
  signal?.throwIfAborted();
  const cli = locateCli();
  return new Promise<CodeBuddyResult>((resolve, reject) => {
    const child = spawn(cli.command, [...cli.args, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnvironment(cli.args),
    });
    const parts: any[] = [];
    let diagnostic = "";
    let stdoutDiagnostic = "";
    let buffer = "";
    let result: any;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (idle) clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
    };
    const kill = () => {
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        } else child.kill();
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      reject(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Request cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const activity = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => fail(new Error("CodeBuddy: no output for 10 minutes")), 600000);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      activity();
      stdoutDiagnostic = (stdoutDiagnostic + chunk).slice(-2000);
      buffer += chunk;
      let next: number;
      while ((next = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, next).replace(/\r$/, "").trim();
        buffer = buffer.slice(next + 1);
        if (!line) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "assistant" && Array.isArray(event.message?.content)) parts.push(...event.message.content);
        if (event.type === "result") result = event;
        onEvent(event);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-2000);
    });

    child.once("error", error => fail(error instanceof Error ? error : new Error(String(error))));
    child.once("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result?.is_error) {
        const message = (result.errors ?? []).join("; ") || "CodeBuddy returned an error";
        reject(new Error(message));
        return;
      }
      if (!result) {
        reject(new Error(`CodeBuddy exited without a result record: ${diagnostic || stdoutDiagnostic}`));
        return;
      }
      if (!parts.length && typeof result.result === "string" && result.result.trim()) {
        parts.push({ type: "text", text: result.result });
      }
      resolve({ parts, usage: result.usage, finalText: typeof result.result === "string" ? result.result : undefined });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
