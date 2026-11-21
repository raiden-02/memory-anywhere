// Chat history exports (chatgpt-history, claude-history; importers.md §3). Each export parser turns
// its own JSON into `Conversation`s; this module applies the rules both share:
//
//   conversation ──► user-authored turns only ──► inside --since/--until ──► ≥ min user turns (default 2)
//        │
//        └─► each turn: skip own output (rule 3) → redact (rule 4) → over 4,000 chars? split into
//            paragraphs, drop fenced code and quoted paragraphs (> 70 % of lines start with `>`)
//            → batches of ≤ 20 pieces = one extract item, group_id = the conversation, date = when said

import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import { Collector, hasMarker, hasWords, MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_ITEM, packSentences } from "./common.ts";
import type { ImportOptions, ImportResult, SourceType } from "./types.ts";

export const DEFAULT_MIN_USER_TURNS = 2;
const QUOTED_SHARE = 0.7;

export interface HistoryMessage {
	readonly id: string | undefined;
	/** Only `user` turns are ever read; assistant, system and tool turns are `other`. */
	readonly author: "user" | "other";
	readonly text: string;
	readonly time: Date | undefined;
}

export interface Conversation {
	readonly id: string;
	readonly time: Date | undefined;
	readonly messages: readonly HistoryMessage[];
}

/** A paragraph that is pasted material rather than the owner's words: fenced code, or mostly `>`-quoted lines. */
export function isQuotedOrCode(paragraph: string): boolean {
	const lines = paragraph.split(/\r?\n/u).filter((l) => l.trim() !== "");
	if (lines.length === 0) return false;
	if (/^(```|~~~)/u.test(lines[0]?.trim() ?? "")) return true;
	return lines.filter((l) => l.trimStart().startsWith(">")).length / lines.length > QUOTED_SHARE;
}

/** Paragraphs separated by blank lines; a fenced code block (even with blank lines inside) stays one paragraph. */
export function paragraphs(text: string): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	let fence: string | undefined;
	const flush = (): void => {
		if (cur.some((l) => l.trim() !== "")) out.push(cur.join("\n").trim());
		cur = [];
	};
	for (const line of text.split(/\r?\n/u)) {
		const t = line.trim();
		if (fence) {
			cur.push(line);
			if (t.startsWith(fence)) {
				fence = undefined;
				flush();
			}
			continue;
		}
		const open = /^(```|~~~)/u.exec(t)?.[1];
		if (open) {
			flush();
			fence = open;
			cur.push(line);
			continue;
		}
		if (t === "") flush();
		else cur.push(line);
	}
	flush();
	return out;
}

/**
 * The pieces of one (already redacted) message that go to the extractor: the message itself when it
 * fits in 4,000 characters; otherwise its paragraphs without quoted material, each cut to 4,000.
 */
export function messagePieces(text: string): { pieces: string[]; dropped: number } {
	if (text.length <= MAX_MESSAGE_CHARS) return { pieces: [text], dropped: 0 };
	const paras = paragraphs(text);
	const kept = paras.filter((p) => !isQuotedOrCode(p));
	return { pieces: kept.flatMap((p) => packSentences(p, MAX_MESSAGE_CHARS)), dropped: paras.length - kept.length };
}

/** `2026-03-01` (the whole day) or a full ISO date-time; undefined for no value. Throws on anything else. */
export function parseDateFlag(value: string | undefined, edge: "start" | "end"): Date | undefined {
	if (value === undefined || value === "") return undefined;
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
	const d = new Date(dateOnly ? `${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z` : value);
	if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${value} (use YYYY-MM-DD or an ISO date-time)`);
	return d;
}

/** Seconds since 1970 (ChatGPT) or an ISO string (Claude) → Date. */
export function toDate(value: unknown): Date | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
	if (typeof value === "string" && value !== "") {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? undefined : d;
	}
	return undefined;
}

export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The conversations array of an export file: the file's top-level array, or its `conversations` field. */
export function conversationArray(text: string, file: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${file} is not JSON; expected conversations.json from the data export`);
	}
	if (Array.isArray(parsed)) return parsed;
	if (isObject(parsed) && Array.isArray(parsed["conversations"])) return parsed["conversations"];
	throw new Error(`${file} holds no conversations array`);
}

interface Piece {
	readonly text: string;
	readonly messageId: string | undefined;
	readonly time: Date | undefined;
}

export function importHistory(
	sourceType: SourceType,
	conversations: Iterable<Conversation>,
	o: ImportOptions,
): ImportResult {
	const c = new Collector(sourceType);
	const minTurns = o.conversationMinUserTurns ?? DEFAULT_MIN_USER_TURNS;
	const inWindow = (t: Date | undefined): boolean =>
		t === undefined
			? o.since === undefined && o.until === undefined
			: (!o.since || t >= o.since) && (!o.until || t <= o.until);
	for (const conv of conversations) {
		c.count("conversations_read");
		const user = conv.messages.filter((m) => m.author === "user");
		c.count("user_messages_read", user.length);
		c.count("other_messages_skipped", conv.messages.length - user.length);
		const said = user.filter((m) => hasWords(m.text));
		c.count("skipped_empty", user.length - said.length);
		const dated = said.filter((m) => inWindow(m.time ?? conv.time));
		c.count("skipped_outside_dates", said.length - dated.length);
		if (dated.length === 0) continue;
		if (dated.length < minTurns) {
			c.count("skipped_few_user_turns_conversations");
			c.count("skipped_few_user_turns_messages", dated.length);
			continue;
		}
		c.count("conversations_kept");
		const pieces: Piece[] = [];
		for (const m of dated) {
			if (hasMarker(m.text)) {
				c.count("skipped_marker");
				continue;
			}
			const clean = c.redacted(m.text);
			if (clean === undefined) continue;
			const { pieces: ps, dropped } = messagePieces(clean);
			c.count("user_messages_kept");
			if (ps.length > 1 || dropped > 0) c.count("long_messages_split");
			c.count("skipped_quoted_paragraphs", dropped);
			for (const text of ps) pieces.push({ text, messageId: m.id, time: m.time ?? conv.time });
		}
		for (let at = 0, ordinal = 0; at < pieces.length; at += MAX_MESSAGES_PER_ITEM, ordinal++) {
			const batch = pieces.slice(at, at + MAX_MESSAGES_PER_ITEM);
			const first = batch[0];
			if (!first) continue;
			const anchor = first.messageId ?? contentNormHash(first.text).slice(0, 32);
			c.extract(
				`${conv.id}:${anchor}`,
				ordinal,
				batch.map((p) => p.text),
				{
					group_id: conv.id,
					date: first.time?.toISOString(),
				},
			);
		}
	}
	return c.result();
}
