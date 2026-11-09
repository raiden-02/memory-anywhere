#!/usr/bin/env node
// memory-anywhere-server, M0 OAuth spike edition: the stub's commands (stub-server/src/main.ts)
// with the OAuth app (app.ts) serving HTTP, and setup tokens the app accepts. This is what the
// spike instance runs (deployment-aws.md §9).

import { join } from "node:path";
import { main } from "../../stub-server/src/main.ts";
import { createApp } from "./app.ts";
import { issueSetupToken, openDb } from "./db.ts";

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    createServer: (o) => createApp({ publicOrigin: o.publicOrigin, dataDir: o.dataDir, version: o.version }).server,
    issueSetupToken: ({ dataDir, ttlMs }) => {
      const db = openDb(join(dataDir, "oauth.db"));
      try {
        return issueSetupToken(db, Date.now(), ttlMs);
      } finally {
        db.close();
      }
    },
  });
}
