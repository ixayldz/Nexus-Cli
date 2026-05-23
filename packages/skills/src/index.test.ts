import { describe, expect, it } from "vitest";
import { SkillRegistry } from "./index.js";

describe("skill registry", () => {
  it("lists built-in skills and matches triggers", async () => {
    const registry = new SkillRegistry();

    await expect(registry.summaries(process.cwd())).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "code-review" })])
    );
    await expect(registry.match(process.cwd(), "run a security review")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "code-review" }),
        expect.objectContaining({ id: "security-audit" })
      ])
    );
  });
});
