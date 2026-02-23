import { describe, it, expect } from "vitest";
import { extractJson } from "../../src/agents/sdk.js";

// ── extractJson (shared utility) ─────────────────────────────────────────────

describe("extractJson", () => {
  it("parses a response that is pure JSON", () => {
    const raw = JSON.stringify({ patterns: [{ type: "style", count: 3 }] });
    const result = extractJson(raw) as { patterns: unknown[] };
    expect(result.patterns).toHaveLength(1);
  });

  it("parses a response with leading prose before JSON", () => {
    const raw =
      'Analyzing the code now...\n\nHere is my assessment:\n{"patterns":[{"type":"naming","count":2}]}';
    const result = extractJson(raw) as { patterns: unknown[] };
    expect(result).toEqual({ patterns: [{ type: "naming", count: 2 }] });
  });

  it("parses a response with trailing commentary after JSON", () => {
    const raw =
      '{"patterns":[{"type":"complexity","count":5}]}\n\nLet me know if you need more detail.';
    const result = extractJson(raw) as { patterns: unknown[] };
    expect(result).toEqual({ patterns: [{ type: "complexity", count: 5 }] });
  });

  it("parses a response with both leading prose and trailing commentary", () => {
    const raw =
      'Sure! Here is the analysis:\n```json\n{"patterns":[]}\n```\nHope that helps!';
    const result = extractJson(raw) as { patterns: unknown[] };
    expect(result).toEqual({ patterns: [] });
  });

  it("parses a response wrapped in markdown code fences", () => {
    const raw = "```json\n{\"score\": 42}\n```";
    const result = extractJson(raw) as { score: number };
    expect(result.score).toBe(42);
  });

  it("prefers the last valid JSON block when multiple exist", () => {
    // Claude sometimes thinks aloud with intermediate JSON before the final answer
    const raw =
      'I considered {"patterns":[{"type":"old"}]} but revised to {"patterns":[{"type":"final"}]}';
    const result = extractJson(raw) as { patterns: Array<{ type: string }> };
    expect(result.patterns[0].type).toBe("final");
  });

  it("throws a descriptive error for a completely unparseable response", () => {
    const raw = "Analyzing the pull request now. I will get back to you shortly.";
    expect(() => extractJson(raw)).toThrow(/extractJson: no valid JSON found/);
    expect(() => extractJson(raw)).toThrow(/Raw snippet:/);
  });

  it("includes a snippet of the raw text in the error message for debuggability", () => {
    const raw = "This is definitely not JSON at all!";
    let caught: Error | undefined;
    try {
      extractJson(raw);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("This is definitely not JSON at all!");
  });

  it("throws on an empty string", () => {
    expect(() => extractJson("")).toThrow(/extractJson: no valid JSON found/);
  });
});

// ── parseCodeQualityResult (via the analyst's public contract) ────────────────
//
// Because parseCodeQualityResult is not exported we test it indirectly through
// the extractJson helper it relies on plus a small inline re-implementation
// that mirrors the production logic.

function invokeParseCodeQualityResult(text: string) {
  // Mirrors src/agents/code-quality-analyst.ts parseCodeQualityResult
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    const snippet = text.slice(0, 120).replace(/\n/g, " ");
    throw new Error(
      `parseCodeQualityResult: failed to extract JSON from LLM response. ` +
      `Original error: ${(err as Error).message}. ` +
      `Raw snippet: "${snippet}"`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    const snippet = text.slice(0, 120).replace(/\n/g, " ");
    throw new Error(
      `parseCodeQualityResult: expected a JSON object, got ${typeof parsed}. ` +
      `Raw snippet: "${snippet}"`
    );
  }

  const obj = parsed as Record<string, unknown>;
  return {
    patterns: Array.isArray(obj.patterns) ? obj.patterns : [],
  };
}

describe("parseCodeQualityResult (logic)", () => {
  it("handles a pure-JSON response", () => {
    const raw = JSON.stringify({ patterns: [{ type: "style", severity: "low" }] });
    const result = invokeParseCodeQualityResult(raw);
    expect(result.patterns).toHaveLength(1);
  });

  it("handles a response with leading prose before JSON", () => {
    const raw = 'Analyzing "src/foo.ts"...\n\n{"patterns":[{"type":"complexity","severity":"high"}]}';
    const result = invokeParseCodeQualityResult(raw);
    expect(result.patterns[0]).toMatchObject({ type: "complexity", severity: "high" });
  });

  it("handles a response with trailing commentary after JSON", () => {
    const raw = '{"patterns":[{"type":"naming"}]}\n\nOverall the code looks fine.';
    const result = invokeParseCodeQualityResult(raw);
    expect(result.patterns[0]).toMatchObject({ type: "naming" });
  });

  it("returns empty patterns array when field is missing from JSON", () => {
    const raw = '{"summary":"all good"}';
    const result = invokeParseCodeQualityResult(raw);
    expect(result.patterns).toEqual([]);
  });

  it("throws a descriptive error (not a raw SyntaxError) for completely unparseable input", () => {
    const raw = 'Analyzing "src/bar.ts"... please wait while I review this.';
    expect(() => invokeParseCodeQualityResult(raw)).toThrow(
      /parseCodeQualityResult: failed to extract JSON/
    );
    // Must NOT be a raw SyntaxError leaking through
    expect(() => invokeParseCodeQualityResult(raw)).not.toThrow(
      /Unexpected token/
    );
  });

  it("error message contains a snippet of the raw response", () => {
    const raw = "Analyzing the pull request for quality issues...";
    let caught: Error | undefined;
    try {
      invokeParseCodeQualityResult(raw);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("Analyzing the pull request for quality issues");
  });
});
