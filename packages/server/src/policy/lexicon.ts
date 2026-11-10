// Phrase matching for the policy lexicons. Every lexicon is matched against normalized text
// (`norm()`, data-model.md §1), in one of two modes:
// - word:      the phrase must start and end at word boundaries ("this pr" matches "fixing this pr"
//              but not "this project"); used for action verbs, short-lived wording and the
//              sensitive categories.
// - substring: the phrase may sit inside a longer word ("remember" matches "remembered"); used for
//              override phrases, remember intent and past markers.

export type MatchMode = "word" | "substring";

export interface Lexicon {
  /** The first phrase of the list that occurs in `normalized`, or undefined. */
  firstMatch(normalized: string): string | undefined;
  matches(normalized: string): boolean;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A letter or digit; anything else (space, punctuation, string edge) is a word boundary. */
const WORD_CHAR = "[\\p{L}\\p{N}]";

export function lexicon(phrases: readonly string[], mode: MatchMode): Lexicon {
  const compiled = phrases.map((phrase) => ({
    phrase,
    re:
      mode === "word"
        ? new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(phrase)}(?!${WORD_CHAR})`, "u")
        : new RegExp(escapeRegExp(phrase), "u"),
  }));
  return {
    firstMatch: (normalized) => compiled.find((c) => c.re.test(normalized))?.phrase,
    matches: (normalized) => compiled.some((c) => c.re.test(normalized)),
  };
}
