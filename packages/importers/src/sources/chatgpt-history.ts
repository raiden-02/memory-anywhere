// `chatgpt-history`: conversations.json from ChatGPT's data export ZIP (importers.md §3). Each
// conversation is a tree of nodes, because an edited message starts a new branch:
//
//   { conversation_id | id, title, create_time (seconds), current_node,
//     mapping: { <node id>: { id, parent, children,
//                             message: { id, create_time, author: { role: "user" | "assistant" | "system" | "tool" },
//                                        content: { content_type: "text" | "multimodal_text" | …, parts: [string | object] },
//                                        metadata: { is_visually_hidden_from_conversation? } } } } }
//
// The conversation as the owner last saw it is the path from `current_node` up to the root; without
// one, every node in time order. Only visible `user` messages of type text or multimodal_text are
// the owner's words (custom instructions arrive as a hidden `user_editable_context` message).

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

const TEXT_TYPES = new Set(["text", "multimodal_text"]);

/** The nodes on the branch the owner last saw, root first. */
export function branch(mapping: Json, currentNode: string | undefined): Json[] {
	if (currentNode && isObject(mapping[currentNode])) {
		const path: Json[] = [];
		const seen = new Set<string>();
		for (let id: string | undefined = currentNode; id && !seen.has(id);) {
			seen.add(id);
			const node: unknown = mapping[id];
			if (!isObject(node)) break;
			path.push(node);
			id = str(node["parent"]);
		}
		return path.reverse();
	}
	const time = (n: Json): number => {
		const m = n["message"];
		return isObject(m) && typeof m["create_time"] === "number" ? m["create_time"] : 0;
	};
	return Object.values(mapping)
		.filter(isObject)
		.sort((a, b) => time(a) - time(b));
}

function toMessage(node: Json): HistoryMessage | undefined {
	const m = node["message"];
	if (!isObject(m)) return undefined;
	const role = isObject(m["author"]) ? str(m["author"]["role"]) : undefined;
	const content = isObject(m["content"]) ? m["content"] : {};
	const hidden = isObject(m["metadata"]) && m["metadata"]["is_visually_hidden_from_conversation"] === true;
	const isText = TEXT_TYPES.has(str(content["content_type"]) ?? "text");
	const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
	const text = parts.filter((p): p is string => typeof p === "string").join("\n\n");
	return {
		id: str(m["id"]) ?? str(node["id"]),
		author: role === "user" && isText && !hidden ? "user" : "other",
		text,
		time: toDate(m["create_time"]),
	};
}

export function* chatgptConversations(text: string, file: string): Generator<Conversation> {
	for (const raw of conversationArray(text, file)) {
		if (!isObject(raw) || !isObject(raw["mapping"])) continue;
		const messages = branch(raw["mapping"], str(raw["current_node"]))
			.map(toMessage)
			.filter((m): m is HistoryMessage => m !== undefined);
		const id =
			str(raw["conversation_id"]) ??
			str(raw["id"]) ??
			`chatgpt-${sha256Hex(JSON.stringify([raw["title"], raw["create_time"]])).slice(0, 32)}`;
		yield { id, time: toDate(raw["create_time"]), messages };
	}
}

export function chatgptHistory(files: readonly SourceFile[], o: ImportOptions): ImportResult {
	return importHistory(
		"chatgpt-history",
		files.flatMap((f) => [...chatgptConversations(f.text, f.name)]),
		o,
	);
}
