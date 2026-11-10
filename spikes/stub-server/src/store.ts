// Throwaway JSONL store for the M0 stub: append on save, substring match on recall.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface StubMemory {
  id: string;
  text: string;
  user_words: string;
  client: string;
  saved_at: string;
}

export class JsonlStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  save(text: string, userWords: string, client: string): StubMemory {
    const m: StubMemory = { id: `mem_${randomBytes(8).toString("hex")}`, text, user_words: userWords, client, saved_at: new Date().toISOString() };
    appendFileSync(this.file, JSON.stringify(m) + "\n", { mode: 0o600 });
    return m;
  }

  all(): StubMemory[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StubMemory);
  }

  recall(query: string, limit = 10): StubMemory[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hits = this.all().filter((m) => {
      const t = m.text.toLowerCase();
      return t.includes(query.toLowerCase()) || words.some((w) => t.includes(w));
    });
    return hits.slice(-limit).reverse();
  }
}
