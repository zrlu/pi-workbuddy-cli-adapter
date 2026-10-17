import { randomUUID } from "node:crypto";

export function activeTools(context) {
  const tools = new Map((context.tools ?? []).map(tool => [tool.name, tool]));
  for (const message of context.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools.values()];
}

export function bridgeSystemPrompt(context, tools) {
  const sections = new Map();
  const instructions = [context.systemPrompt ?? ""];
  for (const message of context.messages ?? []) {
    if (message.role !== "system") continue;
    instructions.push(typeof message.content === "string" ? message.content : (message.content ?? []).map(p => p.text ?? "").join("\n"));
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [
    ...instructions, ...sections.values(),
    "You are responding inside Pi. Pi executes tools after receiving your response. " +
    "The available Pi tools and their JSON argument schemas are listed below. " +
    "To request a tool, return it in toolCalls; do not execute tools yourself or claim to have executed them. " +
    "Return exactly one JSON object, with no Markdown fences, XML, DSML, or text outside the object: " +
    '{"text":"message to the user (may be empty)","toolCalls":[{"name":"exact tool name","arguments":{}}]}. ' +
    "Use an empty toolCalls array for a final answer. Use only the listed tools and match each argument schema. " +
    "A toolResult message in the conversation contains the result of an earlier call; continue from it, " +
    "and do not repeat a completed call unless needed. Return the next assistant response only.",
    "Available Pi tools:\n" + JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))),
  ].filter(Boolean).join("\n\n");
}

export function bridgeTranscript(context) {
  return JSON.stringify((context.messages ?? []).filter(m => m.role !== "system").map(m => ({
    role: m.role,
    ...(m.role === "toolResult" ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError } : {}),
    content: typeof m.content === "string" ? m.content : (m.content ?? []).filter(p => p.type !== "thinking").map(p => {
      if (p.type === "image") return { type: "text", text: "[Image omitted: this CLI adapter supports text only.]" };
      return p;
    }),
  })));
}

function parseAttributes(source, allowed) {
  const attributes = {};
  let rest = source.trim();
  while (rest) {
    const match = rest.match(/^([a-zA-Z_][\w-]*)\s*=\s*(["'])([\s\S]*?)\2\s*/);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(attributes, match[1])) {
      throw new Error("WorkBuddy returned invalid DSML attributes.");
    }
    attributes[match[1]] = match[3];
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

// DeepSeek sometimes emits its native DSML format even when JSON was requested.
function parseDsml(text) {
  const marker = "｜｜DSML｜｜";
  if (!text.includes(marker)) return undefined;
  const open = `<${marker} calls>`;
  const close = `</${marker} calls>`;
  const start = text.indexOf(open);
  const end = text.indexOf(close, start);
  if (start < 0 || end < 0 || text.indexOf(open, start + open.length) >= 0) {
    throw new Error("WorkBuddy returned incomplete DSML tool calls; no tool was executed.");
  }
  const before = text.slice(0, start).trim();
  const after = text.slice(end + close.length).trim();
  if (before.includes("```") || before.includes(marker) || after.includes(marker)) throw new Error("WorkBuddy returned ambiguous DSML tool calls.");
  let body = text.slice(start + open.length, end).trim();
  const toolCalls = [];
  const invoke = new RegExp(`^<${marker} invoke\\b([^>]*)>([\\s\\S]*?)<\\/${marker} invoke>\\s*`);
  const parameter = new RegExp(`^<${marker} parameter\\b([^>]*)>([\\s\\S]*?)<\\/${marker} parameter>\\s*`);
  while (body) {
    const match = body.match(invoke);
    if (!match) throw new Error("WorkBuddy returned invalid DSML invocation syntax.");
    const attributes = parseAttributes(match[1], ["name"]);
    if (!attributes.name) throw new Error("WorkBuddy DSML invocation has no tool name.");
    const args = {};
    let parameters = match[2].trim();
    while (parameters) {
      const part = parameters.match(parameter);
      if (!part) throw new Error("WorkBuddy returned invalid DSML parameter syntax.");
      const attr = parseAttributes(part[1], ["name", "string"]);
      if (!attr.name || Object.hasOwn(args, attr.name) || !["true", "false"].includes(attr.string)) {
        throw new Error("WorkBuddy returned invalid or duplicate DSML parameters.");
      }
      let value = part[2];
      if (value.includes(marker)) throw new Error("WorkBuddy returned nested DSML parameters.");
      if (attr.string === "false") {
        try { value = JSON.parse(value); }
        catch { throw new Error(`WorkBuddy returned invalid JSON for DSML parameter ${attr.name}.`); }
      }
      Object.defineProperty(args, attr.name, { value, enumerable: true, configurable: true, writable: true });
      parameters = parameters.slice(part[0].length);
    }
    toolCalls.push({ name: attributes.name, arguments: args });
    body = body.slice(match[0].length);
  }
  if (!toolCalls.length) throw new Error("WorkBuddy returned an empty DSML tool call block.");
  return { text: [before, after].filter(Boolean).join("\n\n"), toolCalls };
}

function parseTrailingEnvelope(text) {
  // Accept a standalone envelope after a model's explanatory preamble.
  const candidates = [];
  for (const match of text.matchAll(/^[ \t]*\{/gm)) {
    const start = match.index + match[0].length - 1;
    const suffix = text.slice(start).trim().replace(/\r?\n```$/, "");
    let value;
    try { value = JSON.parse(suffix); } catch { continue; }
    if (value && typeof value.text === "string" && Array.isArray(value.toolCalls)) {
      candidates.push(value);
    }
  }
  if (candidates.length > 1) throw new Error("WorkBuddy returned ambiguous tool-response envelopes.");
  return candidates[0];
}

export function parseBridgeResponse(text, tools) {
  const clean = text.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i, "$1");
  let response;
  try { response = JSON.parse(clean); }
  catch {
    response = parseDsml(text.trim()) ?? parseTrailingEnvelope(clean);
    if (!response) {
      // Ordinary final answers need no tool envelope. Broken call payloads do.
      if (!clean || /^\s*[\[{]/.test(clean) || /"toolCalls"\s*:/.test(clean)) {
        throw new Error("WorkBuddy returned invalid tool-response JSON. Retry the request; no tool was executed.");
      }
      response = { text: clean, toolCalls: [] };
    }
  }
  if (!response || typeof response.text !== "string" || !Array.isArray(response.toolCalls)) {
    throw new Error("WorkBuddy tool response must contain text and toolCalls fields.");
  }
  const allowed = new Set(tools.map(t => t.name));
  const calls = response.toolCalls.map(call => {
    if (!call || !allowed.has(call.name)) throw new Error(`WorkBuddy requested an unavailable Pi tool: ${call?.name}`);
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new Error(`WorkBuddy returned invalid arguments for ${call.name}.`);
    }
    return { type: "toolCall", id: "wb_" + randomUUID(), name: call.name, arguments: call.arguments };
  });
  if (!response.text && !calls.length) throw new Error("WorkBuddy returned an empty response.");
  return { text: response.text, calls };
}
