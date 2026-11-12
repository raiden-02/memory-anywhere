// Child process for the spool fault test: drains the spool in MA_HOME to the store at
// MA_STORE_URL with the token in MA_TOKEN_FILE, slowly enough to be killed in the middle.

import { currentPaths } from "@memory-anywhere/contracts/paths";
import { readFileSync } from "node:fs";
import { drain } from "../../src/spool.ts";
import { StoreClient } from "../../src/store-client.ts";

const store = new StoreClient(process.env["MA_STORE_URL"], readFileSync(process.env["MA_TOKEN_FILE"] ?? "", "utf8").trim());
process.stdout.write("draining\n");
await drain(currentPaths(), store, Date.now() + 30_000);
