# pi-workbuddy-cli-adapter

A [Pi](https://pi.dev) extension that exposes the **WorkBuddy AI** (Tencent
CodeBuddy, overseas channel) CLI as a Pi model provider. It runs the CLI that
already ships inside the WorkBuddy AI desktop app in headless mode and translates
its `stream-json` events into Pi assistant messages. When Pi provides tools, a
validated JSON response bridge returns real Pi `toolCall` blocks and lets Pi
execute them and feed their results into the next turn.

This is a CLI adapter, not a standalone model: it uses the account session the
CLI itself holds. It does **not** read, decrypt, or replay the desktop app's
stored credential — see *Authentication* below.

## How it works

- On each request, `server.ts` spawns the bundled CLI
  (`resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`) as
  `node <cli> -p --output-format stream-json --include-partial-messages --tools "" --model <id>`.
- The Pi conversation (system prompt + role-tagged transcript of prior messages)
  is written to the CLI's **stdin**, avoiding the Windows command-line length
  limit.
- The CLI's newline-delimited JSON is mapped into Pi `text` / `thinking` deltas:
  `content_block_delta` with `text_delta` / `thinking_delta` become deltas, and
  the terminal `result` record supplies token usage and error status.
- CLI built-in tools remain disabled (`--tools ""`). Pi owns tool execution.
- Tool definitions are read from both legacy `context.tools` and normalized
  system-message `toolsAdded` / `toolsRemoved` declarations. Tool results retain
  their call IDs, names, and error status in the next request.
- With tools available, a replacement system prompt requests a JSON envelope
  containing `text` and `toolCalls`. Only listed tool names and object arguments
  are accepted. Pi performs its normal argument-schema validation and execution.
  The adapter emits `toolcall_start`, `toolcall_delta`, `toolcall_end`, and a
  `toolUse` stop reason. DeepSeek's complete native DSML `calls` / `invoke` /
  `parameter` response format is also accepted: `string="true"` preserves strings
  and `string="false"` parses JSON values. Tool names are checked against the active
  Pi tool list and Pi validates arguments before execution. Incomplete calls,
  duplicate parameters, and code-fenced DSML examples are rejected.
- Tool-mode output is buffered until the response envelope validates; ordinary
  text-only requests retain streaming. Plain final answers are also accepted.
  Malformed call payloads fail visibly without running tools. This is a
  prompt-based bridge; valid JSON envelopes and native DeepSeek DSML are supported.
- Large tool schemas are written to a temporary system-prompt file to avoid
  Windows command-line length limits. The file is removed after each request.

## Authentication

The bundled lite CLI has no interactive terminal UI, so launching it and typing
`/login` does not work. In Pi, run `/workbuddy-login`. The extension starts a
short-lived, password-protected CLI HTTP service on a random loopback port and
uses its official account-login API to open WorkBuddy's browser sign-in page.
Complete browser sign-in; the login window automatically waits for confirmation.
The temporary service stops after sign-in or a five-minute timeout. Run `/workbuddy-status` in Pi to verify
that a model request can use the saved session.

Pi uses the separate `pi-workbuddy-cli` authentication profile through the CLI's
product configuration, because the desktop profile requires its own encryption
bootstrap and cannot be reused by an independently started CLI.

An account-status response alone does not establish model access: the lite CLI
can report a desktop account identity while headless requests still need login.

Alternatively, if your account is issued a token/API key, supply it through the
same environment variables the CLI supports:

- `CODEBUDDY_AUTH_TOKEN` or `CODEBUDDY_API_KEY`
- `CODEBUDDY_BASE_URL` (only if your endpoint differs)

If neither is present, Pi will surface the CLI's `Authentication required`
message together with these instructions.

> This adapter deliberately does **not** extract the session that the desktop app
> keeps encrypted in `~/.workbuddy-ai`. Driving the vendor's own client with the
> vendor's own login is the supported path; decrypting and replaying the app's
> credential is not, and is out of scope for this extension.

## Requirements

- WorkBuddy AI installed (the bundled CLI is auto-discovered), **or** a
  `codebuddy` / `cbc` executable on `PATH`, **or** `WORKBUDDY_CLI` pointing at
  either the `.mjs` bundle or an executable.
- Node.js >= 20 (the bundled CLI runs under the current `node`).
- Pi.

## Install

Copy this directory into `~/.pi/agent/extensions/pi-workbuddy-cli-adapter/`.

## Configuring models

Installing this extension does **not** create any model entries. It only
supplies the transport: `registerApiProvider` registers an API type named
`workbuddy-cli-api` bound to the `local-workbuddy` provider. Add the provider and
models yourself in your Pi `models.json`:

```json
{
  "providers": {
    "local-workbuddy": {
      "name": "WorkBuddy AI (local CLI)",
      "api": "workbuddy-cli-api",
      "apiKey": "local",
      "models": [
        { "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "reasoning": true }
      ]
    }
  }
}
```

Notes:

- The `id` must match a model the CLI itself can serve (see the app's
  `cli/product.json`, e.g. `deepseek-v4.1-flash`, `deep-model`, `fast-model`).
  It is passed straight through as `--model`.
- `apiKey` is a formality for the provider record — the adapter carries no
  credentials of its own and does not use this value. Do not paste a real secret.
- Set `reasoning: true` only for models that support it; Pi's reasoning level is
  forwarded as `--effort`.

## Commands

- `/workbuddy-login` — opens browser sign-in through the bundled CLI account API. Complete sign-in; the window automatically detects completion.
- `/workbuddy-status` — runs a trivial prompt through the CLI to verify the session is active.

## Environment overrides

- `WORKBUDDY_CLI` — path to the CLI (`.mjs`/`.cjs`/`.js` is run via node).
- `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` / `CODEBUDDY_BASE_URL` — passed
  through to the CLI unchanged.

## Tests

Run `node --test tools.test.mjs` for tool declaration replay, response parsing,
invalid calls, and tool-result identity checks. The live bridge was also verified
through the installed Pi `Agent`: one tool executed, its result returned to the
model, and the model produced a final answer with no repeated execution.
