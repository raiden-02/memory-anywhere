// LongMemEval-S as a per-question retrieval task (evals.md §3.2): each question has its own
// haystack; documents are rounds (one user turn plus the assistant reply that follows it),
// and a round is relevant when one of its turns has has_answer.

import { readFileSync } from "node:fs";

export type Category = "single" | "update" | "temporal" | "multi-session" | "abstention";
export const CATEGORIES: Category[] = ["single", "update", "temporal", "multi-session", "abstention"];

interface Turn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
}

export interface Doc {
  id: string;
  text: string;
  /** The session's date (LongMemEval format), when known. */
  date?: string;
}

export interface RetrievalItem {
  qid: string;
  category: Category;
  query: string;
  /** When the question is asked (LongMemEval format). */
  questionDate?: string;
  docs: Doc[];
  relevant: string[];
}

/** The category map recorded in split.json (m0-spike plan, evals.md §3.2). */
export function categoryOf(q: Pick<LmeQuestion, "question_id" | "question_type">): Category {
  if (q.question_id.endsWith("_abs")) return "abstention";
  if (q.question_type.startsWith("single-session")) return "single";
  if (q.question_type === "knowledge-update") return "update";
  if (q.question_type === "temporal-reasoning") return "temporal";
  if (q.question_type === "multi-session") return "multi-session";
  throw new Error(`unknown question_type ${q.question_type}`);
}

/** Split one session into rounds: each user turn with the assistant turns up to the next user turn. */
export function rounds(sessionId: string, turns: Turn[], date?: string): { doc: Doc; relevant: boolean }[] {
  const out: { doc: Doc; relevant: boolean }[] = [];
  let current: Turn[] = [];
  const flush = () => {
    if (current.length === 0) return;
    out.push({
      doc: { id: `${sessionId}#${out.length}`, text: current.map((t) => `${t.role}: ${t.content}`).join("\n"), ...(date ? { date } : {}) },
      relevant: current.some((t) => t.has_answer === true),
    });
    current = [];
  };
  for (const t of turns) {
    if (t.role === "user") flush();
    current.push(t);
  }
  flush();
  return out;
}

export function toRetrievalItem(q: LmeQuestion): RetrievalItem {
  const docs: Doc[] = [];
  const relevant: string[] = [];
  q.haystack_sessions.forEach((turns, i) => {
    const sid = q.haystack_session_ids[i] ?? `s${i}`;
    for (const r of rounds(sid, turns, q.haystack_dates[i])) {
      docs.push(r.doc);
      if (r.relevant) relevant.push(r.doc.id);
    }
  });
  const category = categoryOf(q);
  return { qid: q.question_id, category, query: q.question, questionDate: q.question_date, docs, relevant: category === "abstention" ? [] : relevant };
}

export function loadLme(file: string): LmeQuestion[] {
  return JSON.parse(readFileSync(file, "utf8")) as LmeQuestion[];
}
