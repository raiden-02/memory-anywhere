import { expect, it } from "vitest";
import { staleFiles } from "./gen.ts";

it("every generated file is committed and current (run `pnpm gen`)", () => {
  expect(staleFiles()).toEqual([]);
});
