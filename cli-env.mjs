import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Keep Pi's CLI session separate from WorkBuddy desktop's encrypted session.
export function cliEnvironment(args, env = process.env) {
  const bundle = args.find(arg => /codebuddy-lite-wb\.mjs$/i.test(arg));
  if (!bundle) return { ...env };
  const product = JSON.parse(readFileSync(resolve(dirname(bundle), "..", "product.json"), "utf8"));
  const config = JSON.parse(env.ACC_PRODUCT_CONFIG_V3 || env.ACC_PRODUCT_CONFIG_V2 || "{}");
  return {
    ...env,
    ACC_PRODUCT_CONFIG_V3: JSON.stringify({
      ...config,
      authentication: { ...product.authentication, ...config.authentication, id: "pi-workbuddy-cli" },
    }),
  };
}
