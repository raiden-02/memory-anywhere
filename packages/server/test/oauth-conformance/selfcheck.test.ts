// selfcheck (spec-issues #57, #76): the on-instance checks of suite S, and the owner-only routes an
// eval harness uses to ask for them and read the result. The OS calls (IMDS as a user, the raw
// device, the swap file) are injected, so these tests run on any machine.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { fileHolds, parseRequest, runSelfcheck, selfcheckFiles, type SelfcheckEnv } from "../../src/ops/selfcheck.ts";
import { ownerSetup, startIssuer, type Issuer } from "./issuer.ts";

const dirs: string[] = [];
const issuers: Issuer[] = [];
afterEach(async () => {
  for (const i of issuers.splice(0)) await i.stop();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5 }));
});

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ma selfcheck "));
  dirs.push(d);
  return d;
}

function env(o: Partial<SelfcheckEnv> & { dataDir: string }): SelfcheckEnv {
  return { devices: [], swapFiles: [], imdsDeniedUsers: [], runAs: () => 7, now: () => Date.parse("2026-11-12T00:00:00Z"), ...o };
}

test("selfcheck: a canary is found across a 4 MiB read boundary, in UTF-8 and UTF-16, and not where it is absent", () => {
  const d = tmp();
  const split = path.join(d, "split.bin");
  const before = Buffer.alloc(4 * 2 ** 20 - 3, 0x20);
  writeFileSync(split, Buffer.concat([before, Buffer.from("Nettlecombe"), Buffer.alloc(100, 0x20)]));
  expect(fileHolds(split, [Buffer.from("Nettlecombe")])).toBe(true);
  const wide = path.join(d, "wide.bin");
  writeFileSync(wide, Buffer.from("…Nettlecombe…", "utf16le"));
  expect(fileHolds(wide, [Buffer.from("Nettlecombe", "utf16le")])).toBe(true);
  expect(fileHolds(split, [Buffer.from("Quarrymead")])).toBe(false);
  expect(fileHolds(path.join(d, "missing"), [Buffer.from("x")])).toBeUndefined();
});

test("selfcheck: each check fails exactly when its defence is missing, and the result never names a canary", () => {
  const data = tmp();
  writeFileSync(path.join(data, "store.db"), "clean pages only");
  const device = path.join(tmp(), "nvme0n1");
  writeFileSync(device, Buffer.concat([Buffer.alloc(1000), Buffer.from("…keeps a notebook called pennyfold…"), Buffer.alloc(1000)]));
  const swap = path.join(tmp(), "swapfile");
  writeFileSync(swap, Buffer.alloc(5000));
  const allowed = new Set(["litestream"]);
  const r = runSelfcheck({ canaries: ["Pennyfold"] }, env({
    dataDir: data, devices: [device], swapFiles: [swap], imdsDeniedUsers: ["memory-anywhere", "litestream"],
    runAs: (user) => (allowed.has(user) ? 0 : 7),
  }));
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));
  expect(byId).toEqual({
    "imds.denied.memory-anywhere": true,
    "imds.denied.litestream": false, // reached IMDS: the check reports it
    "litestream.no-staging-on-volume": true,
    "purge.data-dir": true,
    [`purge.raw-device:${device}`]: false, // the lower-case copy on the device is found
    [`purge.swap:${swap}`]: true,
  });
  expect(JSON.stringify(r).toLowerCase()).not.toContain("pennyfold");

  mkdirSync(path.join(data, "store.db-litestream"));
  writeFileSync(path.join(data, "store.db-litestream", "0001.ltx"), "x");
  expect(runSelfcheck({ canaries: [] }, env({ dataDir: data })).checks.find((c) => c.id === "litestream.no-staging-on-volume")?.pass).toBe(false);
});

test("selfcheck: requests take 1 to 50 canaries of 4 to 100 characters", () => {
  expect(parseRequest({ canaries: ["Pennyfold"] })).toEqual({ canaries: ["Pennyfold"] });
  for (const bad of [{}, { canaries: [] }, { canaries: ["abc"] }, { canaries: [1] }, { canaries: Array(51).fill("Pennyfold") }]) expect(parseRequest(bad)).toBeUndefined();
});

test("selfcheck routes: off unless the stack turns them on; then owner-only, and the result is read back", async () => {
  const off = await startIssuer();
  issuers.push(off);
  const offOwner = await ownerSetup(off);
  expect((await offOwner.postJson(`${off.adminOrigin}/api/selfcheck`, { canaries: ["Pennyfold"] })).status).toBe(404);

  const issuer = await startIssuer({ selfcheck: true });
  issuers.push(issuer);
  const owner = await ownerSetup(issuer);
  const files = selfcheckFiles(issuer.app.config, issuer.app.config.server.data_dir);
  if (!files) throw new Error("selfcheck should be on");
  expect((await fetch(`${issuer.adminOrigin}/api/selfcheck`)).status).toBe(401); // no session
  expect((await owner.postJson(`${issuer.adminOrigin}/api/selfcheck`, { canaries: ["abc"] })).status).toBe(400);
  expect((await owner.postJson(`${issuer.adminOrigin}/api/selfcheck`, { canaries: ["Pennyfold", "Rookwater"] })).status).toBe(202);
  expect(JSON.parse(readFileSync(files.request, "utf8"))).toEqual({ canaries: ["Pennyfold", "Rookwater"] });
  expect((await owner.fetch(`${issuer.adminOrigin}/api/selfcheck`)).status).toBe(200);
  expect(await (await owner.fetch(`${issuer.adminOrigin}/api/selfcheck`)).json()).toEqual({ status: "pending" });

  // What ma-selfcheck.service does as root: run the checks, drop the request, write the result.
  const request = parseRequest(JSON.parse(readFileSync(files.request, "utf8")));
  rmSync(files.request);
  mkdirSync(path.dirname(files.result), { recursive: true });
  writeFileSync(files.result, JSON.stringify(runSelfcheck(request ?? { canaries: [] }, env({ dataDir: issuer.app.config.server.data_dir }))));
  const done = (await (await owner.fetch(`${issuer.adminOrigin}/api/selfcheck`)).json()) as { status: string; checks: { id: string; pass: boolean }[] };
  expect(done.status).toBe("done");
  expect(done.checks.map((c) => c.id)).toContain("purge.data-dir");
  expect(existsSync(files.request)).toBe(false);
}, 90_000);
