// Asking the person at the terminal. Without a terminal (a script, a coding tool's hook) every
// question takes its default, so nothing ever waits for an answer that cannot come.

import { createInterface } from "node:readline/promises";

/** The answer, or `fallback` when it is empty or there is no terminal. */
export async function ask(question: string, fallback: string): Promise<string> {
	if (!process.stdin.isTTY) return fallback;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(`${question} `)).trim() || fallback;
	} finally {
		rl.close();
	}
}

/** "y" or "yes", in any case. */
export const isYes = (answer: string): boolean => /^y(es)?$/iu.test(answer.trim());

/** A yes/no question whose default is no. */
export async function confirm(question: string): Promise<boolean> {
	return isYes(await ask(`${question} [y/N]`, "n"));
}
