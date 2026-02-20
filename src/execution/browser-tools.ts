import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { ToolResultContent } from "../agents/sdk.js";
import type { Browser, Page } from "playwright";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrowserSession {
  browser: Browser;
  page: Page;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const BROWSER_TOOLS: Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current page. Returns an image.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "click",
    description: "Click an element matching a CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click" },
      },
      required: ["selector"],
    },
  },
  {
    name: "type_text",
    description: "Type text into an element matching a CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the input element" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "get_text",
    description: "Get the visible text content of the page or a specific element.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector (optional — defaults to body)" },
      },
    },
  },
  {
    name: "wait_for",
    description: "Wait for an element matching a CSS selector to appear.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        timeout: { type: "number", description: "Max wait time in milliseconds (default: 10000)" },
      },
      required: ["selector"],
    },
  },
  {
    name: "get_url",
    description: "Get the current page URL.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ── Session management ───────────────────────────────────────────────────────

export async function createBrowserSession(): Promise<BrowserSession> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  return { browser, page };
}

export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  await session.browser.close();
}

// ── Tool executor ────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 8000;

export function createBrowserToolExecutor(
  session: BrowserSession,
): (name: string, input: Record<string, unknown>) => Promise<string | ToolResultContent> {
  return async (name: string, input: Record<string, unknown>): Promise<string | ToolResultContent> => {
    switch (name) {
      case "navigate": {
        const url = input.url as string;
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return `Navigated to ${url}`;
      }

      case "screenshot": {
        const buf = await session.page.screenshot({ type: "png", fullPage: false });
        const base64 = buf.toString("base64");
        return [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: base64 },
          },
        ];
      }

      case "click": {
        const selector = input.selector as string;
        await session.page.click(selector, { timeout: 10_000 });
        return `Clicked ${selector}`;
      }

      case "type_text": {
        const selector = input.selector as string;
        const text = input.text as string;
        await session.page.fill(selector, text);
        return `Typed into ${selector}`;
      }

      case "get_text": {
        const selector = (input.selector as string) ?? "body";
        const text = await session.page.locator(selector).innerText({ timeout: 10_000 });
        const truncated = text.length > MAX_TEXT_LENGTH
          ? text.slice(0, MAX_TEXT_LENGTH) + "\n... (truncated)"
          : text;
        return truncated;
      }

      case "wait_for": {
        const selector = input.selector as string;
        const timeout = (input.timeout as number) ?? 10_000;
        await session.page.waitForSelector(selector, { timeout });
        return `Element ${selector} appeared`;
      }

      case "get_url": {
        return session.page.url();
      }

      default:
        throw new Error(`Unknown browser tool: ${name}`);
    }
  };
}
