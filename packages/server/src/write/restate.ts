// Store rule 6's word checks (write-path.md §8, rule 6). Embeddings alone cannot tell a fact said
// in other words from a different fact said in the same words: "Prefers dark mode in every editor"
// and "Prefers light mode in every editor" are closer (cosine 0.93 with the pinned model) than
// "Laptop runs Fedora" and "Has a laptop that runs Fedora" (0.86). The words can:
//
//   restated      Laptop runs Fedora  ⊆  Has a laptop that runs Fedora      words only added
//   reworded      Has a beagle named Pixel ~ Has a beagle called Pixel       a word swapped: a synonym,
//                 Prefers dark mode   ~ Prefers light mode                  or another value
//   different     Runs 10 km          ≠ Runs 5 km                            a number swapped
//   extended      Is learning Portuguese with a tutor
//                 Is learning Portuguese with a tutor twice a week           whole text, then more
//
// A reworded pair is the same fact only when its vectors are nearly identical (store rule 6 asks a
// higher cosine for it): synonyms measured 0.977–0.981, distinct values up to 0.928 (suite I). A
// swapped number is always another value. A word that turns the meaning around (not, never, no
// longer, used to …) must appear equally often in both, so "Drinks coffee" never merges with
// "No longer drinks coffee".

import { contentWords, norm } from "@memory-anywhere/contracts/normalize";

/** Words that negate or end what the rest of the sentence says; most are stopwords, so they are counted on all tokens. */
const POLARITY: ReadonlySet<string> = new Set([
	"not",
	"no",
	"never",
	"nor",
	"without",
	"t",
	"stopped",
	"quit",
	"formerly",
	"former",
	"used",
	"longer",
	"anymore",
]);

const tokens = (text: string): string[] =>
	norm(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t !== "");

function samePolarity(a: string, b: string): boolean {
	const count = (text: string): number => tokens(text).filter((t) => POLARITY.has(t)).length;
	return count(a) === count(b);
}

/** One content word stands for another: the same word, or (letters, 3 or more) one starts the other, as "run" and "running". */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 3 && /^\p{L}+$/u.test(short) && long.startsWith(short);
}

/**
 * How two texts' words relate, for store rule 6 (always with a cosine threshold, never alone):
 * `restated` when every content word of one is in the other (words only added), `reworded` when
 * each has a word the other lacks but no number differs, else `different`. Texts that disagree on
 * negation are `different`.
 */
export function wording(a: string, b: string): "restated" | "reworded" | "different" {
	if (!samePolarity(a, b)) return "different";
	const wa = contentWords(a);
	const wb = contentWords(b);
	const only = (xs: string[], ys: string[]): string[] => xs.filter((x) => !ys.some((y) => sameWord(x, y)));
	const [onlyA, onlyB] = [only(wa, wb), only(wb, wa)];
	if (onlyA.length === 0 || onlyB.length === 0) return "restated";
	return [...onlyA, ...onlyB].some((w) => /\p{N}/u.test(w)) ? "different" : "reworded";
}

/** `newer` repeats all of `older`, as a run of whole words, and adds more words; negation unchanged. */
export function extendsText(newer: string, older: string): boolean {
	const n = tokens(newer);
	const o = tokens(older);
	if (o.length === 0 || n.length <= o.length || !samePolarity(newer, older)) return false;
	for (let i = 0; i + o.length <= n.length; i++) if (o.every((t, j) => n[i + j] === t)) return true;
	return false;
}
