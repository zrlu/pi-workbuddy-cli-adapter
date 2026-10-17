import test from "node:test";
import assert from "node:assert/strict";
import { activeTools, bridgeTranscript, bridgeSystemPrompt, parseBridgeResponse } from "./tools.mjs";

const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };

test("normalized system messages add and remove tools", () => {
  const context = { messages: [
    { role: "system", content: "base", toolsAdded: [bash, { name: "read" }] },
    { role: "system", content: "update", toolsRemoved: [{ name: "read" }], sections: { rules: "Use pwsh" } },
  ] };
  assert.deepEqual(activeTools(context), [bash]);
  const system = bridgeSystemPrompt(context, activeTools(context));
  assert.match(system, /Use pwsh/);
  assert.match(system, /"command"/);
});

test("tool-only response becomes a call with a unique id", () => {
  const text = JSON.stringify({ text: "", toolCalls: [{ name: "bash", arguments: { command: "pwd" } }] });
  const first = parseBridgeResponse(text, [bash]);
  const second = parseBridgeResponse(text, [bash]);
  assert.equal(first.calls[0].type, "toolCall");
  assert.equal(first.calls[0].arguments.command, "pwd");
  assert.notEqual(first.calls[0].id, second.calls[0].id);
});

test("fenced JSON and final text are accepted", () => {
  assert.deepEqual(parseBridgeResponse('```json\n{"text":"Done","toolCalls":[]}\n```', [bash]), { text: "Done", calls: [] });
});

test("malformed responses and unavailable tools cannot become calls", () => {
  for (const response of [
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash">pwd</｜｜DSML｜｜ invoke>',
    '{"text":"","toolCalls":[{"name":"unknown","arguments":{}}]}',
    '{"text":"","toolCalls":[{"name":"bash","arguments":"pwd"}]}',
    '{"text":"","toolCalls":[]}',
  ]) assert.throws(() => parseBridgeResponse(response, [bash]));
});

test("tool results retain call identity and errors in the next request", () => {
  const context = { messages: [
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pwd" } }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "failure" }], isError: true },
  ] };
  const messages = JSON.parse(bridgeTranscript(context));
  assert.equal(messages[0].content[0].id, messages[1].toolCallId);
  assert.equal(messages[1].isError, true);
});

test("DeepSeek DSML tool calls preserve command strings and typed parameters", () => {
  const text = `Let me find the extension directory.
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">ls -d ~/.pi/agent/extensions/* 2>/dev/null; echo "---"; find ~/.pi -maxdepth 4 -iname "*workbuddy*" 2>/dev/null</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="timeout" string="false">30</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
  const response = parseBridgeResponse(text, [bash]);
  assert.equal(response.text, "Let me find the extension directory.");
  assert.equal(response.calls.length, 1);
  assert.equal(response.calls[0].name, "bash");
  assert.match(response.calls[0].arguments.command, /echo "---"/);
  assert.equal(response.calls[0].arguments.timeout, 30);
});

test("DSML supports multiple tool invocations", () => {
  const invoke = '<｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
  assert.equal(parseBridgeResponse('<｜｜DSML｜｜ calls>' + invoke + invoke + '</｜｜DSML｜｜ calls>', [bash]).calls.length, 2);
});

test("unavailable, duplicate, incomplete, and quoted DSML calls are rejected", () => {
  const call = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  assert.throws(() => parseBridgeResponse(call, []), /unavailable/);
  assert.throws(() => parseBridgeResponse(call.replace('</｜｜DSML｜｜ invoke>', '<｜｜DSML｜｜ parameter name="command" string="true">again</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>'), [bash]), /duplicate/);
  assert.throws(() => parseBridgeResponse(call.replace('</｜｜DSML｜｜ calls>', ''), [bash]), /incomplete/);
  assert.throws(() => parseBridgeResponse('Here is an example:\n```xml\n' + call + '\n```', [bash]), /ambiguous/);
  assert.throws(() => parseBridgeResponse('```\n' + call + '\n```', [bash]), /ambiguous/);
});

test("plain final answers work without a JSON envelope", () => {
  assert.deepEqual(parseBridgeResponse("The repository is ready.", [bash]), { text: "The repository is ready.", calls: [] });
  assert.throws(() => parseBridgeResponse('{"text":"bad","toolCalls":[', [bash]), /invalid tool-response/);
});

test("explanatory preamble before a trailing tool-response envelope is accepted", () => {
  const response = parseBridgeResponse('The earlier create raced the commit. Retrying serially.\n\n' + JSON.stringify({
    text: "Retrying now that the commit exists.",
    toolCalls: [{ name: "bash", arguments: { command: 'echo "repo description"' } }],
  }), [bash]);
  assert.equal(response.text, "Retrying now that the commit exists.");
  assert.equal(response.calls.length, 1);
  assert.equal(response.calls[0].arguments.command, 'echo "repo description"');
});

test("preamble cannot bypass tool validation or hide a malformed envelope", () => {
  assert.throws(() => parseBridgeResponse('Checking.\n{"text":"","toolCalls":[{"name":"missing","arguments":{}}]}', [bash]), /unavailable/);
  assert.throws(() => parseBridgeResponse('Checking.\n{"text":"","toolCalls":[', [bash]), /invalid tool-response/);
});
