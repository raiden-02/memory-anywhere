// M0 Q20: TLS handshake timing from the owner's PC to candidate AWS regions.
//
//   node spikes/rtt/src/rtt.ts measure [--n 50] [--out <run.json>]
//   node spikes/rtt/src/rtt.ts decide <run.json>... [--out <decision.json>]
//
// measure: each sample is one fresh TCP connect + TLS handshake to
// s3.<region>.amazonaws.com:443 (no session resumption), timed from connect()
// to 'secureConnect'. DNS is resolved once per region beforehand, so DNS time
// is not in the samples. Regions are interleaved round-robin, so a network blip
// hits all of them alike.
// decide: pools the samples of one or more runs and applies the rule in choose.ts.

import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { parseArgs } from "node:util";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, decideRegion, summarize, type RegionSamples } from "./choose.ts";

export const REGIONS = ["us-east-1", "us-east-2", "us-west-2"] as const;

interface RunFile {
  question: "Q20";
  measured_at: string;
  samples_ms: Record<string, number[]>;
}

function handshakeMs(ip: string, servername: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const socket = tls.connect({ host: ip, port: 443, servername, ALPNProtocols: ["http/1.1"] });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    socket.once("secureConnect", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      socket.destroy();
      resolve(ms);
    });
    socket.once("error", reject);
  });
}

function writeJson(file: string | undefined, value: unknown): void {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

async function measure(n: number, out: string | undefined): Promise<void> {
  const targets = await Promise.all(
    REGIONS.map(async (region) => {
      const host = `s3.${region}.amazonaws.com`;
      const { address } = await lookup(host, { family: 4 });
      return { region, host, address };
    }),
  );

  const samples = new Map<string, number[]>(REGIONS.map((r) => [r, []]));
  const errors: { region: string; round: number; error: string }[] = [];
  for (let round = 0; round < n; round++) {
    for (const t of targets) {
      try {
        samples.get(t.region)?.push(await handshakeMs(t.address, t.host));
      } catch (e) {
        errors.push({ region: t.region, round, error: (e as Error).message });
      }
    }
  }

  const series: RegionSamples[] = REGIONS.map((region) => ({ region, samplesMs: samples.get(region) ?? [] }));
  const summaries = series.map(summarize);
  console.table(summaries);
  if (errors.length) console.log(`${errors.length} failed handshakes`);
  writeJson(out, {
    question: "Q20",
    measured_at: new Date().toISOString(),
    method: "fresh TCP+TLS handshake to s3.<region>.amazonaws.com:443, DNS resolved once, regions interleaved",
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    samples_per_region: n,
    summaries,
    errors,
    samples_ms: Object.fromEntries(series.map((s) => [s.region, s.samplesMs.map((x) => Math.round(x * 100) / 100)])),
  });
}

function decide(files: readonly string[], out: string | undefined): void {
  if (files.length === 0) throw new Error("decide needs at least one run file");
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as RunFile);
  const series: RegionSamples[] = REGIONS.map((region) => ({
    region,
    samplesMs: runs.flatMap((r) => r.samples_ms[region] ?? []),
  }));
  const decision = decideRegion(series);
  console.table(series.map(summarize));
  console.table(decision.comparisons.map((c) => ({ ...c, ci95Ms: `[${c.ci95Ms.join(", ")}]` })));
  console.log(`fastest median: ${decision.fastest}; chosen region: ${decision.chosen}`);
  writeJson(out, {
    question: "Q20",
    decided_at: new Date().toISOString(),
    rule: `lowest median; a region whose 95% bootstrap CI of the median difference to the fastest includes 0 is tied; ties go to us-east-1 (${BOOTSTRAP_RESAMPLES} resamples, seed ${BOOTSTRAP_SEED})`,
    runs: runs.map((r, i) => ({ file: path.basename(files[i] as string), measured_at: r.measured_at })),
    summaries: series.map(summarize),
    ...decision,
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { n: { type: "string", default: "50" }, out: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  if (command === "measure") {
    const n = Number(values.n);
    if (!Number.isInteger(n) || n < 1) throw new Error("--n must be a positive integer");
    await measure(n, values.out);
  } else if (command === "decide") {
    decide(rest, values.out);
  } else {
    console.error("usage: rtt.ts measure [--n 50] [--out file] | rtt.ts decide <run.json>... [--out file]");
    process.exitCode = 1;
  }
}

await main();
