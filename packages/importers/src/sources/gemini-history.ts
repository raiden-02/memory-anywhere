// `gemini-history`: Gemini's chats from a Google Takeout of My Activity → Gemini Apps, in JSON
// (importers.md §3). The file is `…/Gemini Apps/MyActivity.json`, read tolerantly (fields that are
// missing or of another type are skipped, never guessed):
//
//   [ { header: "Gemini Apps", products: ["Gemini Apps"], time,
//       title: "Prompted <the owner's prompt>",   ← the only entries that are the owner's words
//       safeHtmlItem: [ { html } … ],             ← Gemini's reply: never read
//       attachedFiles, imageFile, subtitles } … ] ← pasted files and links: never read
//
// Other titles ("Used an Assistant feature", "Gave feedback: …", "Created …") are not prompts. The
// export has no conversation ids, so prompts are grouped into sessions: a gap of more than
// SESSION_GAP_MINUTES between two prompts starts a new one. A session's id comes from its first
// prompt's time, so a newer export of the same history gives the same ids.

import { sha256Hex } from "../common.ts";
import { conversationArray, importHistory, isObject, str, toDate, type Conversation, type Json } from "../history.ts";
import type { ImportOptions, ImportResult, SourceFile } from "../types.ts";

const PROMPTED = /^Prompted\s+/u;
/** Two prompts further apart than this belong to different sessions. */
export const SESSION_GAP_MINUTES = 30;

function isGemini(e: Json): boolean {
	const products = Array.isArray(e["products"]) ? e["products"] : [];
	return (
		str(e["header"])?.startsWith("Gemini") === true ||
		products.some((p) => typeof p === "string" && p.startsWith("Gemini"))
	);
}

interface Prompt {
	readonly text: string;
	readonly time: Date;
}

export function* geminiConversations(text: string, file: string): Generator<Conversation> {
	const prompts: Prompt[] = [];
	for (const raw of conversationArray(text, file)) {
		if (!isObject(raw) || !isGemini(raw)) continue;
		const title = str(raw["title"]);
		const time = toDate(raw["time"]);
		if (!title || !time || !PROMPTED.test(title)) continue;
		prompts.push({ text: title.replace(PROMPTED, ""), time });
	}
	// Takeout lists the newest first.
	prompts.sort((a, b) => a.time.getTime() - b.time.getTime());

	let session: Prompt[] = [];
	const close = (): Conversation | undefined => {
		const first = session[0];
		if (!first) return undefined;
		const id = `gemini-${sha256Hex(first.time.toISOString()).slice(0, 32)}`;
		const conv = {
			id,
			time: first.time,
			messages: session.map((p, i) => ({ id: `${id}-${i}`, author: "user" as const, text: p.text, time: p.time })),
		};
		session = [];
		return conv;
	};
	for (const p of prompts) {
		const last = session.at(-1);
		if (last && p.time.getTime() - last.time.getTime() > SESSION_GAP_MINUTES * 60_000) {
			const conv = close();
			if (conv) yield conv;
		}
		session.push(p);
	}
	const conv = close();
	if (conv) yield conv;
}

export function geminiHistory(files: readonly SourceFile[], o: ImportOptions): ImportResult {
	return importHistory(
		"gemini-history",
		files.flatMap((f) => [...geminiConversations(f.text, f.name)]),
		o,
	);
}
