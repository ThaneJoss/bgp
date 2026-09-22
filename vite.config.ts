import vinext from "vinext";
import { readFileSync, rmSync } from "node:fs";
import { defineConfig } from "vite";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { sites } from "./build/sites-vite-plugin";

// Keep production bindings and routes in the deployment configuration. Vite
// consumes the source entry, while Wrangler deploys its generated output.
const deployment = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
const runtimeConfig = Object.fromEntries(Object.entries(deployment).filter(([key]) =>
  !["$schema", "build", "main", "no_bundle", "find_additional_modules", "rules", "assets"].includes(key)
));
const assetConfig = Object.fromEntries(Object.entries(deployment.assets).filter(([key]) => key !== "directory"));
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

export default defineConfig(async () => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(managedLinux ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] } : {}),
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux }),
      cloudflare({
        configPath: "./wrangler.vite.jsonc",
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: { ...runtimeConfig, assets: assetConfig },
      }),
      {
        name: "bgp-use-source-deploy-config",
        apply: "build",
        enforce: "post",
        closeBundle() {
          // Default Wrangler commands must rebuild from source on every run,
          // instead of following Vite's redirect to yesterday's output.
          rmSync(new URL("./.wrangler/deploy/config.json", import.meta.url), { force: true });
        },
      },
    ],
  };
});
