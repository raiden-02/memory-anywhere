// Test helpers for the client: a private data folder with a space in its path, and a real local
// server (the server package's App over HTTP with the fake embedder) to talk to.

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { resolvePaths, type Paths } from "@memory-anywhere/contracts/paths";
import { App } from "../../server/src/app.ts";
import { defaultConfig } from "../../server/src/config/schema.ts";
import { Logger } from "../../server/src/http/log.ts";
import { localHttpServer } from "../../server/src/http/server.ts";
import { fakeEmbedder, testStore, type TestStore } from "../../server/test/helpers/store.ts";
import { parseClientConfig, type ClientConfigT } from "../src/config.ts";
import { StoreClient } from "../src/store-client.ts";

export const TOKEN = "client-test-token-0123456789abcdefghijklmnopqrs";

export function tempHome(): { dir: string; paths: Paths; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma client "));
  return { dir, paths: resolvePaths({ platform: process.platform as "win32", env: { MA_HOME: path.join(dir, "data") }, home: dir }), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

export const localConfig = (): ClientConfigT => parseClientConfig('schema = 1\n[store]\nmode = "local"\n').config;

export interface LocalServer {
  readonly store: TestStore;
  readonly app: App;
  readonly url: string;
  readonly client: StoreClient;
  stop(): Promise<void>;
}

export async function localServer(): Promise<LocalServer> {
  const store = await testStore({ memory: true });
  const app = new App({ db: store.db, config: defaultConfig(), embedder: fakeEmbedder, clock: store.clock, ids: store.ids });
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const server: Server = localHttpServer({ app, port, localToken: TOKEN, logger: new Logger(() => undefined) });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  let stopped = false;
  return {
    store, app, url, client: new StoreClient(url, TOKEN),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
