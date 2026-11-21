// Docker plumbing shared by the external baselines (evals.md §7): each system runs from an image
// built locally from a directory under evals/adapters/ (a Dockerfile on a digest-pinned base and
// a hash-locked requirements.txt). The tag carries a hash of that directory's files, so editing a
// pin builds a new image instead of silently reusing a stale one.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuiltImage {
	readonly tag: string;
	/** Docker's content id of the image (sha256:…). */
	readonly id: string;
}

/** Hash of every file in a build directory, by name and content, in name order. */
export function buildContextHash(dir: string): string {
	const h = createHash("sha256");
	for (const name of readdirSync(dir).sort()) {
		h.update(name)
			.update("\0")
			.update(readFileSync(join(dir, name)))
			.update("\0");
	}
	return h.digest("hex").slice(0, 12);
}

/** The image for a build directory, built first if this exact context has no image yet. */
export function ensureImage(
	dir: string,
	repo: string,
	version: string,
	log: (line: string) => void = () => {},
): BuiltImage {
	const tag = `${repo}:${version}-${buildContextHash(dir)}`;
	if (!imageId(tag)) {
		log(`building ${tag} (first use; a few minutes)`);
		const r = spawnSync("docker", ["build", "--tag", tag, dir], {
			stdio: ["ignore", "ignore", "pipe"],
			encoding: "utf8",
		});
		if (r.status !== 0) throw new Error(`docker build of ${dir} failed:\n${r.stderr.slice(-4000)}`);
	}
	const id = imageId(tag);
	if (!id) throw new Error(`docker image ${tag} is missing after the build`);
	return { tag, id };
}

function imageId(tag: string): string | undefined {
	try {
		return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

/** Arguments for `docker run` of a throwaway container whose state lives in memory only. */
export function runArgs(image: string, name: string, env: Readonly<Record<string, string>>): string[] {
	return [
		"run",
		"--rm",
		"--interactive",
		"--name",
		name,
		// State is per container and dies with it: nothing is written to the host.
		"--tmpfs",
		"/data",
		// Lets a container reach the host's Ollama on Linux too (Docker Desktop defines it already).
		"--add-host",
		"host.docker.internal:host-gateway",
		...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
		image,
	];
}

/** Remove a container by name, if it still exists. */
export function removeContainer(name: string): void {
	spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
}

/** A container name no other run uses. */
export function containerName(system: string): string {
	return `ma-eval-${system}-${process.pid}-${Date.now().toString(36)}`;
}
