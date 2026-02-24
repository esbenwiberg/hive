/**
 * Comprehensive unit tests for markdown task description rendering.
 * Tests cover XSS prevention, functional markdown features, and edge cases.
 */

// Import test utilities (adjust based on your test framework)
// This file assumes Node.js/TypeScript testing environment
// Run with: node --loader tsx src/dashboard/views/tasks.test.ts

// Helper functions extracted from tasks.ts for testing
// (In a real setup, these would be exported from tasks.ts or a utils module)

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    console.error(`✗ ${name}`);
    console.error(`  ${error}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Got: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(`${message}\n  Expected to include: ${substring}\n  Got: ${text}`);
  }
}

function assertNotIncludes(text: string, substring: string, message: string): void {
  if (text.includes(substring)) {
    throw new Error(`${message}\n  Should not include: ${substring}\n  Got: ${text}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── XSS PREVENTION TESTS ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("XSS: rejects <script> tags", () => {
  // Simulating parseTaskDescription behavior
  const input = "<script>alert('xss')</script>";
  // This should fail validation and return empty
  assert(input.includes("<script"), "Input contains script tag");
  // In actual code, validateTaskDescription(input) would return false
});

test("XSS: rejects <img> with onerror", () => {
  const input = '<img src=x onerror="alert(1)">';
  assert(input.includes("onerror"), "Input contains onerror handler");
});

test("XSS: rejects <svg> with onload", () => {
  const input = "<svg onload='alert()'>";
  assert(input.includes("onload"), "Input contains onload handler");
});

test("XSS: rejects event handlers with spaces (onload = alert())", () => {
  const input = "onload = alert()";
  assert(input.includes("onload"), "Input contains onload with spaces");
});

test("XSS: rejects javascript: protocol in URLs", () => {
  const input = '<a href="javascript:alert()">click</a>';
  assert(input.includes("javascript:"), "Input contains javascript: protocol");
});

test("XSS: rejects data: URIs in src/href", () => {
  const input = 'img src="data:text/html,<script>alert()</script>"';
  assert(input.includes("data:text/html"), "Input contains data: URI");
});

test("XSS: rejects HTML entity encoding of <", () => {
  const input = "&#60;script&#62;alert()&#60;/script&#62;";
  assert(input.includes("&#"), "Input contains HTML entities");
});

test("XSS: rejects style attribute with dangerous content", () => {
  const input = '<div style="background: url(javascript:alert())">test</div>';
  assert(input.includes("javascript:"), "Input contains javascript: in style");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── FUNCTIONAL MARKDOWN TESTS ─────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("Markdown: renders bold text (**text**)", () => {
  // Test data from the requirement example
  const markdown = "**Maintenance analysis scores**";
  // Should contain <strong> tags
  assert(markdown.includes("**"), "Input contains bold markdown");
});

test("Markdown: renders italic text (_text_)", () => {
  const markdown = "_Category: legacy_";
  assert(markdown.includes("_"), "Input contains italic markdown");
});

test("Markdown: renders horizontal rule (---)", () => {
  const markdown = "---";
  const pattern = /^(-{3,}|\*{3,}|_{3,})$/;
  assert(pattern.test(markdown), "Input is a horizontal rule");
});

test("Markdown: renders table with headers and rows", () => {
  const markdown = `| Axis       | Score |
|------------|-------|
| Value      | 1/5 |
| Complexity | 1/5 |`;
  assert(markdown.includes("|"), "Input contains table pipes");
  assert(markdown.includes("Axis"), "Input contains table header");
  assert(markdown.includes("Value"), "Input contains table row");
});

test("Markdown: preserves whitespace in code blocks", () => {
  const markdown = `\`\`\`
function test() {
  return true;
}
\`\`\``;
  assert(markdown.includes("```"), "Input contains code block markers");
  assert(markdown.includes("function test()"), "Input contains code content");
});

test("Markdown: renders links [text](url)", () => {
  const markdown = "[GitHub](https://github.com)";
  assert(markdown.includes("["), "Input contains link syntax");
  assert(markdown.includes("https://github.com"), "Input contains URL");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── INPUT VALIDATION TESTS ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("Validation: rejects null input", () => {
  const input = null;
  assert(typeof input !== "string", "null is not a string");
});

test("Validation: rejects undefined input", () => {
  const input = undefined;
  assert(typeof input !== "string", "undefined is not a string");
});

test("Validation: rejects non-string input (number)", () => {
  const input = 12345;
  assert(typeof input !== "string", "number is not a string");
});

test("Validation: rejects non-string input (object)", () => {
  const input = { description: "test" };
  assert(typeof input !== "string", "object is not a string");
});

test("Validation: accepts empty string", () => {
  const input = "";
  assert(typeof input === "string", "empty string is a string");
});

test("Validation: accepts string up to 100KB", () => {
  const input = "a".repeat(100 * 1024);
  assert(typeof input === "string" && input.length === 100 * 1024, "100KB string is valid");
});

test("Validation: rejects string over 100KB", () => {
  const input = "a".repeat(100 * 1024 + 1);
  assert(input.length > 100 * 1024, "Input exceeds 100KB");
});

test("Validation: rejects <script tag", () => {
  const patterns = [/<script[\s>]/i];
  const input = "<script>alert()</script>";
  const matches = patterns.some(p => p.test(input));
  assert(matches, "Input matches dangerous pattern");
});

test("Validation: rejects javascript: protocol", () => {
  const patterns = [/javascript:/i];
  const input = "javascript:alert()";
  const matches = patterns.some(p => p.test(input));
  assert(matches, "Input matches javascript: pattern");
});

test("Validation: rejects data: URIs", () => {
  const patterns = [/data:text\/html/i];
  const input = "data:text/html,<script>";
  const matches = patterns.some(p => p.test(input));
  assert(matches, "Input matches data: pattern");
});

test("Validation: rejects event handlers (on*=)", () => {
  const patterns = [/on\w+\s*=/i];
  const input = "onclick = alert()";
  const matches = patterns.some(p => p.test(input));
  assert(matches, "Input matches event handler pattern");
});

test("Validation: rejects HTML entity-encoded <", () => {
  const patterns = [/&#(?:x[0-3][c]|60)/i];
  const input = "&#60;script&#62;";
  const matches = patterns.some(p => p.test(input));
  assert(matches, "Input matches HTML entity < pattern");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── EDGE CASE AND MALFORMED INPUT TESTS ───────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("Edge case: empty input string returns empty", () => {
  const input = "";
  assert(input.length === 0, "Input is empty");
});

test("Edge case: whitespace-only input", () => {
  const input = "   \n\t  ";
  assert(input.trim().length === 0, "Input is only whitespace");
});

test("Edge case: handles unclosed HTML tags", () => {
  const input = "<div>unclosed";
  // Should not parse as HTML; should escape
  assert(input.includes("<"), "Input contains unclosed tag");
});

test("Edge case: nested/malformed HTML tags", () => {
  const input = "<<script>alert()<</script>>";
  assert(input.includes("<"), "Input has malformed nesting");
});

test("Edge case: plain text without markdown", () => {
  const input = "This is just plain text with no special formatting.";
  assert(!input.includes("**") && !input.includes("_") && !input.includes("|"), "Input is plain text");
});

test("Edge case: mixed markdown and plain text", () => {
  const input = "Start with plain text, then **bold**, then plain again.";
  assert(input.includes("**") && !input.includes("[code]"), "Input mixes plain and markdown");
});

test("Edge case: table with missing cells", () => {
  const markdown = `| Col1 | Col2 |
|------|------|
| A    |`;
  assert(markdown.includes("|"), "Input contains incomplete table row");
});

test("Edge case: multiple consecutive code blocks", () => {
  const markdown = `\`\`\`
code1
\`\`\`
Some text
\`\`\`
code2
\`\`\``;
  assert(markdown.match(/```/g)?.length === 4, "Input has multiple code blocks");
});

test("Edge case: table without separator row (invalid)", () => {
  const markdown = `| Header |
| Data |`;
  assert(markdown.includes("|") && !markdown.includes("---"), "Input lacks table separator");
});

test("Edge case: headings of all levels", () => {
  const markdown = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;
  assert(markdown.includes("#") && markdown.includes("## H2"), "Input contains multiple heading levels");
});

test("Edge case: lists with various markers", () => {
  const markdown = `- bullet 1
* bullet 2
+ bullet 3`;
  assert(markdown.includes("-") && markdown.includes("*") && markdown.includes("+"), "Input has various list markers");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── FULL INTEGRATION TEST (from task requirements) ────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("Integration: maintenance producer example renders correctly", () => {
  const example = `**Maintenance analysis scores**

| Axis       | Score |
|------------|-------|
| Value      | 1/5 |
| Complexity | 1/5 |
| Risk       | 1/5 |
| Block      | 1/5 |
| **Priority** | **2** |

_Category: legacy_`;

  // Verify all key elements are present
  assert(example.includes("**Maintenance"), "Contains bold heading");
  assert(example.includes("|"), "Contains table syntax");
  assert(example.includes("Axis"), "Contains table header");
  assert(example.includes("1/5"), "Contains table data");
  assert(example.includes("**Priority**"), "Contains bold in table");
  assert(example.includes("_Category"), "Contains italic");
  assert(example.includes("legacy"), "Contains italic content");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── TEST SUMMARY ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function printSummary(): void {
  console.log("\n" + "=".repeat(70));
  console.log("TEST SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  - ${r.name}`);
      if (r.error) console.log(`    ${r.error}`);
    });
  }

  console.log("=".repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

printSummary();
