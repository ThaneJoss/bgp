import { mkdirSync } from "node:fs";

// `wrangler preview` validates the assets directory before running the custom
// build. Installation creates only that directory; Wrangler builds the app.
mkdirSync(new URL("../dist/client/", import.meta.url), { recursive: true });
