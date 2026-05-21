import { describe, expect, it } from "vitest";
import { createId, redactString, safeJsonStringify, setIdCounterForTests } from "./index.js";

describe("shared primitives", () => {
  it("creates deterministic ids in tests", () => {
    setIdCounterForTests(1);
    expect(createId("evt")).toBe("evt_0001");
    expect(createId("evt")).toBe("evt_0002");
    setIdCounterForTests(undefined);
  });

  it("redacts common secret shapes", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnop")).toContain("[REDACTED]");
    expect(redactString("api_key=sk-secretvalue")).toContain("[REDACTED]");
  });

  it("safely stringifies circular values", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(safeJsonStringify(value)).toContain("[Circular]");
  });
});
