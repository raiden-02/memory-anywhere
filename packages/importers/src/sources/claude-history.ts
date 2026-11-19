// `claude-history`: conversations.json from Claude's data export ZIP (importers.md §3). The shape,
// read tolerantly (fields that are missing or of another type are skipped, never guessed):
//
//   [ { uuid, name, created_at,
//       chat_messages: [ { uuid, sender: "human" | "assistant", created_at,
//                          text,                                  ← the message text
//                          content: [ { type: "text", text } … ]  ← newer exports; used when text is empty
//                          attachments, files } … ] } … ]          ← pasted files: never read
//
// Only `sender: "human"` turns are the owner's words.

import { sha256Hex } from "../common.ts";
import {
	conversationArray,
	importHistory,
	isObject,
	str,
	toDate,
	type Conversation,
	type HistoryMessage,
	type Json,
} from "../history.ts";
import type { ImportOptions, ImportResult, SourceFile } from "../types.ts";

function messageText(m: Json): string {
	const text = str(m["text"]);
	if (text) return text;
	const content = Array.isArray(m["content"]) ? m["content"] : [];
	return content
		.filter((p): p is Json => isObject(p) && p["type"] === "text")
		.map((p) => str(p["text"]) ?? "")
		.filter((t) => t !== "")
		.join("\n\n");
}

function author(m: Json): HistoryMessage["author"] {
	const role = str(m["sender"]) ?? str(m["role"]);
	return role === "human" || role === "user" ? "user" : "other";
}

export function* claudeConversations(text: string, file: string): Generator<Conversation> {
	for (const raw of conversationArray(text, file)) {
		if (!isObject(raw)) continue;
		const msgs = Array.isArray(raw["chat_messages"]) ? raw["chat_messages"] : [];
		const messages: HistoryMessage[] = msgs.filter(isObject).map((m) => ({
			id: str(m["uuid"]) ?? str(m["id"]),
			author: author(m),
			text: messageText(m),
			time: toDate(m["created_at"]),
		}));
		const id =
			str(raw["uuid"]) ??
			str(raw["id"]) ??
			`claude-${sha256Hex(JSON.stringify([raw["name"], raw["created_at"]])).slice(0, 32)}`;
		yield { id, time: toDate(raw["created_at"]), messages };
	}
}

export function claudeHistory(files: readonly SourceFile[], o: ImportOptions): ImportResult {
	return importHistory(
		"claude-history",
		files.flatMap((f) => [...claudeConversations(f.text, f.name)]),
		o,
	);
}
