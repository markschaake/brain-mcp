import { describe, it, expect, afterEach } from "vitest";
import { parseAccessible } from "./db.js";

describe("parseAccessible", () => {
  const origEnv = process.env.BRAIN_ACCESSIBLE;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.BRAIN_ACCESSIBLE;
    } else {
      process.env.BRAIN_ACCESSIBLE = origEnv;
    }
  });

  it("returns empty array when BRAIN_ACCESSIBLE is not set", () => {
    delete process.env.BRAIN_ACCESSIBLE;
    expect(parseAccessible("personal")).toEqual([]);
  });

  it("returns empty array when BRAIN_ACCESSIBLE is empty string", () => {
    process.env.BRAIN_ACCESSIBLE = "";
    expect(parseAccessible("personal")).toEqual([]);
  });

  it("parses comma-separated brain names", () => {
    process.env.BRAIN_ACCESSIBLE = "work,personal";
    const result = parseAccessible("personal");
    expect(result).toContain("work");
    expect(result).toContain("personal");
  });

  it("trims whitespace from brain names", () => {
    process.env.BRAIN_ACCESSIBLE = " work , personal ";
    const result = parseAccessible("personal");
    expect(result).toContain("work");
    expect(result).toContain("personal");
  });

  it("includes brainName if not already in the list", () => {
    process.env.BRAIN_ACCESSIBLE = "work,shared";
    const result = parseAccessible("personal");
    expect(result).toContain("personal");
    expect(result).toContain("work");
    expect(result).toContain("shared");
  });

  it("does not duplicate brainName if already in list", () => {
    process.env.BRAIN_ACCESSIBLE = "work,personal";
    const result = parseAccessible("personal");
    const count = result.filter((n) => n === "personal").length;
    expect(count).toBe(1);
  });
});
