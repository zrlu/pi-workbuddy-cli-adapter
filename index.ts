import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { runCodeBuddy } from "./server";
import { AUTH_HINT, locateCli } from "./auth";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { activeTools, bridgeSystemPrompt, bridgeTranscript, parseBridgeResponse } from "./tools.mjs";

const API = "workbuddy-cli-api";
const PROVIDER = "local-workbuddy";

function kindOf(type: string | undefined): "text" | "thinking" | undefined {
  if (type === "text") return "text";
  if (type === "thinking" || type === "reasoning") return "thinking";
  return undefined;
}

export function workbuddyStreamSimple(model: any, context: any, options: any = {}) {
  const tools = activeTools(context);
  const toolMode = tools.length > 0;
  const stream = new AssistantMessageEventStream();
  const output: any = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  const blocks = new Map<number, { index: number; kind: "text" | "thinking"; ended: boolean }>();
  let sawDelta = false;
  const emit = (type: string, data: any) => stream.push({ type, ...data } as any);

  function ensure(kind: "text" | "thinking", index: number) {
    let block = blocks.get(index);
    if (!block) {
      block = { index: output.content.length, kind, ended: false };
      blocks.set(index, block);
      output.content.push(kind === "thinking" ? { type: kind, thinking: "" } : { type: kind, text: "" });
      emit(`${kind}_start`, { contentIndex: block.index, partial: output });
    }
    return block;
  }
  function append(kind: "text" | "thinking", index: number, delta: string) {
    if (!delta) return;
    const block = ensure(kind, index);
    output.content[block.index][block.kind] += delta;
    sawDelta = true;
    emit(`${block.kind}_delta`, { contentIndex: block.index, delta, partial: output });
  }
  function finish(index: number) {
    const block = blocks.get(index);
    if (!block || block.ended) return;
    block.ended = true;
    emit(`${block.kind}_end`, { contentIndex: block.index, content: output.content[block.index][block.kind], partial: output });
  }
  function applyUsage(usage: any) {
    if (!usage) return;
    if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
    if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
    output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  }
  // Fallback for backends/settings that omit partial events: expand the final
  // assistant message content when nothing was streamed incrementally.
  function reconcile(content: any[]) {
    if (sawDelta) return;
    for (const part of content ?? []) {
      const kind = kindOf(part?.type) ?? (part?.text ? "text" : undefined);
      if (kind === "text" && part.text) output.content.push({ type: "text", text: part.text });
      else if (kind === "thinking" && (part.thinking ?? part.text)) {
        output.content.push({ type: "thinking", thinking: part.thinking ?? part.text });
      }
    }
  }
  function onEvent(event: any) {
    if (toolMode) {
      if (event.type === "result") applyUsage(event.usage);
      return;
    }
    if (event.type === "assistant") {
      reconcile(event.message?.content ?? []);
      return;
    }
    if (event.type === "result") {
      applyUsage(event.usage);
      return;
    }
    const ev = event.type === "stream_event" ? (event.event ?? event) : event;
    switch (ev.type) {
      case "content_block_start": {
        const kind = kindOf(ev.content_block?.type);
        if (!kind) return;
        const index = ev.index ?? 0;
        ensure(kind, index);
        if (kind === "text" && ev.content_block?.text) append("text", index, ev.content_block.text);
        if (kind === "thinking" && ev.content_block?.thinking) append("thinking", index, ev.content_block.thinking);
        return;
      }
      case "content_block_delta": {
        const index = ev.index ?? 0;
        const delta = ev.delta ?? {};
        if (delta.type === "text_delta") append("text", index, delta.text ?? "");
        else if (delta.type === "thinking_delta") append("thinking", index, delta.thinking ?? delta.text ?? "");
        return;
      }
      case "content_block_stop":
        finish(ev.index ?? 0);
        return;
      case "message_start":
        applyUsage(ev.message?.usage);
        return;
      case "message_delta":
        applyUsage(ev.usage);
        return;
      default:
        return;
    }
  }

  (async () => {
    emit("start", { partial: output });
    let promptDirectory: string | undefined;
    try {
      const contentText = (content: any) => typeof content === "string"
        ? content
        : (content ?? []).map((part: any) => part.text ?? (part.type === "toolCall" ? JSON.stringify(part) : "")).filter(Boolean).join("\n");
      const transcript = (context.messages ?? [])
        .map((message: any) => `${message.role}:\n${contentText(message.content)}`)
        .join("\n\n");
      const prompt = toolMode
        ? `Continue this Pi conversation and return the next assistant response as the required JSON object:\n${bridgeTranscript(context)}`
        : `Continue the following conversation. Respond to the final message.\n\n${transcript}`;

      const args = [
        "-p", "--output-format", "stream-json", "--include-partial-messages",
        "--tools", "", // plain model: no filesystem/shell tools
        "--model", model.id,
      ];
      if (toolMode) {
        promptDirectory = mkdtempSync(join(tmpdir(), "pi-workbuddy-prompt-"));
        const systemFile = join(promptDirectory, "system.txt");
        writeFileSync(systemFile, bridgeSystemPrompt(context, tools), { mode: 0o600 });
        args.push("--system-prompt-file", systemFile);
      }
      else if (context.systemPrompt) args.push("--append-system-prompt", context.systemPrompt);
      if (typeof options.reasoning === "string") args.push("--effort", options.reasoning);

      const result = await runCodeBuddy(args, prompt, onEvent, options.signal);
      if (toolMode) {
        const response = parseBridgeResponse(result.finalText ?? result.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""), tools);
        if (response.text) { append("text", 0, response.text); finish(0); }
        for (const call of response.calls) {
          const contentIndex = output.content.length;
          const part = { ...call, arguments: {} };
          output.content.push(part);
          emit("toolcall_start", { contentIndex, partial: output });
          part.arguments = call.arguments;
          emit("toolcall_delta", { contentIndex, delta: JSON.stringify(call.arguments), partial: output });
          emit("toolcall_end", { contentIndex, toolCall: part, partial: output });
        }
        output.stopReason = response.calls.length ? "toolUse" : "stop";
      } else if (!sawDelta && !output.content.length) reconcile(result.parts);
      for (const index of blocks.keys()) finish(index);
      applyUsage(result.usage);
      if (!output.content.some((part: any) => (part.type === "text" && part.text) || part.type === "toolCall")) {
        throw new Error("CodeBuddy returned no text");
      }
      emit("done", { reason: output.stopReason, message: output });
      stream.end();
    } catch (error: any) {
      const message = error?.message ?? String(error);
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = /Authentication required/i.test(message) ? `${message}\n\n${AUTH_HINT}` : message;
      emit("error", { reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (promptDirectory && dirname(promptDirectory) === tmpdir() && basename(promptDirectory).startsWith("pi-workbuddy-prompt-")) {
        rmSync(promptDirectory, { recursive: true, force: true });
      }
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  const run = (model: any, context: any, options: any) => workbuddyStreamSimple(model, context, options);
  registerApiProvider({ api: API, stream: run, streamSimple: run }, PROVIDER);

  // Check whether the CLI has a valid session by running a trivial prompt.
  async function checkAuth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await runCodeBuddy(
        ["-p", "--output-format", "stream-json", "--tools", "", "--model", "deepseek-v4.1-flash"],
        "Reply with the single word: ok",
        () => {},
        new AbortController().signal,
      );
      const text = (result.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
      if (/Authentication required/i.test(text)) return { ok: false, detail: "Not signed in" };
      if (text) return { ok: true, detail: `Authenticated (CLI replied: \"${text.slice(0, 40)}\")` };
      return { ok: false, detail: "Empty response" };
    } catch (error: any) {
      const msg = error?.message ?? String(error);
      if (/Authentication required/i.test(msg)) return { ok: false, detail: "Not signed in" };
      return { ok: false, detail: msg };
    }
  }

  pi.registerCommand?.("workbuddy-login", {
    description: "Open a terminal to sign in to WorkBuddy AI (CodeBuddy) CLI",
    handler: async (_args: string, ctx: any) => {
      const notify = (message: string, level: string) => { if (ctx.hasUI) ctx.ui.notify(message, level); else console.log(message); };
      let cli: ReturnType<typeof locateCli>;
      try { cli = locateCli(); } catch (e: any) { notify(e.message, "error"); return; }
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const scriptPath = join(mkdtempSync(join(tmpdir(), "workbuddy-login-")), "login.ps1");
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const helper = fileURLToPath(new URL("./login.mjs", import.meta.url));
      const launchLine = [process.execPath, helper, cli.command, ...cli.args].map(quote).join(" ");
      writeFileSync(scriptPath, `Write-Host "WorkBuddy browser sign-in" -ForegroundColor Cyan\n& ${launchLine}\nRead-Host "Press Enter to close"\nRemove-Item -LiteralPath $PSCommandPath -Force\n`);
      const launcher = spawn("pwsh", ["-NoProfile", "-Command", `Start-Process pwsh -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"'`], { detached: true, windowsHide: true, stdio: "ignore" });
      launcher.on("error", (error: Error) => notify(`Could not open login terminal: ${error.message}`, "error"));
      launcher.unref();
      notify("Opened WorkBuddy browser sign-in. Complete sign-in in the browser; the login window detects completion automatically. Then run /workbuddy-status.", "info");
    },
  });

  pi.registerCommand?.("workbuddy-status", {
    description: "Check WorkBuddy CLI authentication status",
    handler: async (_args: string, ctx: any) => {
      const notify = (message: string, level: string) => { if (ctx.hasUI) ctx.ui.notify(message, level); else console.log(message); };
      notify("Checking WorkBuddy CLI auth…", "info");
      const status = await checkAuth();
      notify(status.ok ? `✓ ${status.detail}` : `✗ ${status.detail}. Run /workbuddy-login to sign in.`, status.ok ? "info" : "warning");
    },
  });
}
