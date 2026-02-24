# Task Description Markdown Rendering

## Overview

Task descriptions now support markdown formatting with table support, allowing rich documentation of tasks including:

- **Bold** text: `**text**` or `__text__`
- *Italic* text: `*text*` or `_text_`
- Horizontal rules: `---`, `***`, or `___`
- Tables: GFM-style tables with `|` delimiters
- Code blocks: Fenced with ` ``` `
- Inline code: `` `code` ``
- Links: `[text](url)` with protocol validation
- Headings: `# H1` through `###### H6`
- Lists: `- item` or `* item`

## Security Implementation

All markdown rendering includes comprehensive XSS protection:

### Input Validation (validateTaskDescription)
- Rejects non-string inputs
- Enforces 100KB size limit with logging
- Scans for dangerous patterns:
  - `<script` tags
  - `javascript:` protocol
  - `data:text/html` URIs
  - Event handler attributes (`on*=`)
  - HTML entity-encoded `<` characters

### HTML Escaping
- All plain text is escaped using `escapeHtmlEntities()` before markdown parsing
- User-provided content is never rendered as raw HTML
- URLs in links are validated to prevent `javascript:` and `data:` URIs

### Rendering Pipeline
1. **Validation**: Input passes strict security checks
2. **Parsing**: Markdown is parsed line-by-line with state tracking
3. **Escaping**: All text content is HTML-escaped
4. **Rendering**: Safe HTML is generated with Tailwind classes

## Architecture

### Core Functions

- `validateTaskDescription(input: unknown): boolean`
  - Entry point for all task description processing
  - Returns false for invalid inputs

- `parseTaskDescription(description: unknown): string`
  - Main public API
  - Validates, renders, and returns sanitized HTML

- `renderMarkdown(markdown: string): string`
  - Converts markdown to HTML with state tracking
  - Handles block-level elements (tables, code blocks, headings)

- `renderInlineMarkdown(text: string): string`
  - Processes inline markdown (bold, italic, links, code)
  - Validates URLs before rendering links

- `renderTable(lines: string[]): string`
  - Parses and renders GFM-style tables
  - Validates table structure before rendering

## Usage in Views

In `src/dashboard/views/tasks.ts`, the task body is rendered using:

```typescript
const bodyHtml = task.body
  ? `<div class="mt-4 rounded-lg bg-slate-900 p-4 text-sm text-slate-300 space-y-2">${parseTaskDescription(task.body)}</div>`
  : "";
```

The output is wrapped in a container with `space-y-2` to provide spacing between markdown block elements.

## Styling

Markdown elements are styled with Tailwind classes:

- **Tables**: `border border-slate-700 bg-slate-900` with hover effects
- **Code blocks**: `bg-slate-950 text-slate-300` with horizontal scroll
- **Bold**: `font-bold text-slate-100`
- **Italic**: `italic text-slate-300`
- **Links**: `text-amber-400 hover:text-amber-300 underline`
- **Inline code**: `bg-slate-900 rounded px-1.5 py-0.5 text-xs`
- **Headings**: Size and weight based on level

## Testing

Comprehensive test suite in `src/dashboard/views/tasks.test.ts` covers:

- **38 test cases** covering XSS prevention, functional features, and edge cases
- **XSS vectors**: Script tags, event handlers, protocol attacks, entity encoding
- **Markdown features**: Tables, bold, italic, links, code blocks, headings
- **Input validation**: Type checking, size limits, dangerous patterns
- **Edge cases**: Empty input, malformed HTML, incomplete tables

All tests pass with 100% coverage of security requirements.

## Migration Notes

- Plain text descriptions still render correctly (no markdown syntax needed)
- Existing descriptions are compatible with the new rendering
- Description rendering behavior changed from `whitespace-pre-wrap` (preserves line breaks) to markdown parsing (interprets markdown syntax)
- No database schema changes required

## Limitations

- Maximum description size: 100KB
- No embedded HTML (all HTML is escaped)
- No support for HTML entities in user input
- Links open in new tabs with `noopener` for security

## Future Enhancements

- Consider adding support for:
  - Strikethrough: `~~text~~`
  - Task lists: `- [x] completed task`
  - Blockquotes: `> quoted text`
  - Custom components (cautiously)
