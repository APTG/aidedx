import { describe, expect, it } from "vitest";
import { cn } from "./utils.js";

describe("cn", () => {
  it("joins truthy class values and drops falsy ones", () => {
    expect(cn("a", false, "b", null, undefined, "c")).toBe("a b c");
  });

  it("flattens arrays and object maps", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });
});
