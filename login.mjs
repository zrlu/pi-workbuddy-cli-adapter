import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cliEnvironment } from "./cli-env.mjs";

// Use the bundled CLI's account API because the lite build has no terminal UI.
export async function login(command, args, { checkOnly = false } = {}) {
  const password = randomBytes(32).toString("hex");
  const child = spawn(command, [...args, "--serve", "--host", "127.0.0.1", "--port", "0"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...cliEnvironment(args), CODEBUDDY_GATEWAY_PASSWORD: password },
  });
  let output = "";
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Login service did not start within 30 seconds.")); }, 30000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Login service exited (${code}).`)); });
      const read = chunk => {
        output = (output + chunk.toString()).slice(-16000);
        const match = output.match(/Endpoint\s+(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
    });
    const request = async (path, body) => {
      const response = await fetch(`${endpoint}/api/v1/auth/account/${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${password}`, "X-CodeBuddy-Request": "1", "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Account ${path}: HTTP ${response.status}`);
      const result = await response.json();
      return result.data ?? result;
    };
    if (checkOnly) {
      const status = await request("status");
      console.log(`Login service OK; account API reachable; authenticated=${!!status.authenticated}`);
      return;
    }
    const result = await request("login", { method: "external" });
    if (result.loginError) throw new Error(result.loginError);
    if (!result.authUrl) throw new Error("WorkBuddy did not return a login URL. Please retry.");
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:") throw new Error("WorkBuddy returned an invalid login URL.");
    console.log("Complete sign-in in your browser. If it did not open, use this link:\n" + url.href);
    const escaped = url.href.replaceAll("'", "''");
    const opener = spawn("pwsh", ["-NoProfile", "-Command", `Start-Process '${escaped}'`], { windowsHide: true, stdio: "ignore" });
    opener.on("error", error => console.error("Could not open the browser: " + error.message));
    console.log("Waiting for browser sign-in to finish (up to 5 minutes)...");
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = await request("status");
      if (status.loginError) throw new Error(status.loginError);
      if (status.authenticated) {
        console.log("Signed in. Return to Pi and run /workbuddy-status to verify model access.");
        return;
      }
    }
    throw new Error("Sign-in timed out. Run /workbuddy-login to try again.");
  } finally {
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[2]) {
  const checkOnly = process.argv[2] === "--check";
  const offset = checkOnly ? 3 : 2;
  login(process.argv[offset], process.argv.slice(offset + 1), { checkOnly }).catch(error => {
    console.error("WorkBuddy login failed: " + error.message);
    process.exitCode = 1;
  });
}
