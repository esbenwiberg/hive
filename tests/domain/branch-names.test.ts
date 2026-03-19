import { describe, it, expect, vi } from "vitest";
import {
  generateBranchName,
  generateBranchNameWithRetry,
  isValidBranchPrefix,
} from "../../src/domain/branch-names.js";

describe("generateBranchName", () => {
  it("returns correct format: {prefix}/{verb}-{animal}-{taskId}", () => {
    const name = generateBranchName("hive", "HIVE-20250319-ab12");
    expect(name).toMatch(/^hive\/[a-z]+-[a-z]+-HIVE-20250319-ab12$/);
  });

  it("works with custom prefix", () => {
    const name = generateBranchName("feature", "HIVE-20250319-ab12");
    expect(name).toMatch(/^feature\/[a-z]+-[a-z]+-HIVE-20250319-ab12$/);
  });

  it("generates different names on successive calls (probabilistic)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateBranchName("hive", "HIVE-TEST"));
    }
    // With 3840 combinations, 20 calls should produce at least 2 unique names
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("generateBranchNameWithRetry", () => {
  it("returns first name when no collision", async () => {
    const existsCheck = vi.fn().mockResolvedValue(false);
    const name = await generateBranchNameWithRetry("hive", "HIVE-TEST", existsCheck);
    expect(name).toMatch(/^hive\/[a-z]+-[a-z]+-HIVE-TEST$/);
    expect(existsCheck).toHaveBeenCalledTimes(1);
  });

  it("retries when branch exists", async () => {
    // First 3 calls return true (exists), 4th returns false
    const existsCheck = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const name = await generateBranchNameWithRetry("hive", "HIVE-TEST", existsCheck);
    expect(name).toMatch(/^hive\/[a-z]+-[a-z]+-HIVE-TEST$/);
    expect(existsCheck).toHaveBeenCalledTimes(4);
  });

  it("falls back to timestamp suffix after max retries", async () => {
    const existsCheck = vi.fn().mockResolvedValue(true);
    const name = await generateBranchNameWithRetry("hive", "HIVE-TEST", existsCheck, 3);
    // After 4 checks (0..3) all return true, fallback appends timestamp
    expect(name).toMatch(/^hive\/[a-z]+-[a-z]+-HIVE-TEST-\d+$/);
  });
});

describe("isValidBranchPrefix", () => {
  it("accepts alphanumeric + hyphens", () => {
    expect(isValidBranchPrefix("hive")).toBe(true);
    expect(isValidBranchPrefix("my-prefix")).toBe(true);
    expect(isValidBranchPrefix("feature123")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidBranchPrefix("")).toBe(false);
  });

  it("rejects strings over 30 chars", () => {
    expect(isValidBranchPrefix("a".repeat(31))).toBe(false);
    expect(isValidBranchPrefix("a".repeat(30))).toBe(true);
  });

  it("rejects special characters", () => {
    expect(isValidBranchPrefix("hive/branch")).toBe(false);
    expect(isValidBranchPrefix("hive branch")).toBe(false);
    expect(isValidBranchPrefix("hive@branch")).toBe(false);
  });
});
