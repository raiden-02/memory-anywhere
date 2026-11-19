import { afterEach, describe, expect, it } from "vitest";
import { errorTrace, onUnexpectedError, toErrorObject, WriteError, type ErrorTrace } from "../src/write/types.ts";

afterEach(() => onUnexpectedError(() => undefined));

describe("how the server answers an error", () => {
	it("passes a write error on with its field", () => {
		expect(toErrorObject(new WriteError("INVALID_INPUT", "content is empty", "content"))).toEqual({
			code: "INVALID_INPUT",
			message: "content is empty",
			details: { field: "content" },
		});
	});

	it("turns a busy database into a retryable answer", () => {
		expect(toErrorObject(new Error("database is locked")).code).toBe("STORE_UNAVAILABLE");
	});

	it("answers anything else as INTERNAL and reports where it came from, never what it said", () => {
		const reported: ErrorTrace[] = [];
		onUnexpectedError((t) => reported.push(t));
		const secret = new TypeError("Lives in Lisbon");
		expect(toErrorObject(secret)).toEqual({ code: "INTERNAL", message: "internal error", details: {} });
		expect(reported).toHaveLength(1);
		expect(reported[0]?.error_class).toBe("TypeError");
		expect(reported[0]?.error_at).toMatch(/errors\.test\.ts:\d+:\d+$/u);
		expect(JSON.stringify(reported)).not.toContain("Lisbon");
	});

	it("traces a thrown value that is not an Error", () => {
		expect(errorTrace("oops")).toEqual({ error_class: "string", error_at: "unknown" });
	});
});
