import { tool } from "langchain";
import * as z from "zod";

const fetchTextFromUrlInputSchema = z.object({
  url: z.string().url().describe("The plain-text document URL to fetch."),
  substrings: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Case-sensitive substrings to count by line. Each line is counted at most once per substring.",
    ),
});

export const fetchTextFromUrlTool = tool(
  async ({ url, substrings }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; my-ai-can-do/1.0)",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          ok: false,
          error: `Fetch failed: HTTP ${response.status} ${response.statusText}`,
        });
      }

      const text = await response.text();
      const lines = splitDocumentLines(text);
      const requestedSubstrings = [...new Set(substrings ?? [])];

      return JSON.stringify({
        ok: true,
        url,
        totalLines: lines.length,
        totalCharacters: text.length,
        lineStats: requestedSubstrings.map((substring) =>
          getSubstringLineStats(lines, substring),
        ),
        preview: text.slice(0, 3000),
        note:
          "Line numbers are 1-based. Substring matching is case-sensitive and counts matching lines, not occurrences.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return JSON.stringify({
        ok: false,
        error: `Fetch failed: ${message}`,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  },
  {
    name: "fetch_text_from_url",
    description:
      "Fetch a plain-text document from a URL and return verifiable line stats. Pass requested substrings when the user asks for exact line counts or first line positions.",
    schema: fetchTextFromUrlInputSchema,
  },
);

function splitDocumentLines(text: string) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");

  if (normalizedText.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function getSubstringLineStats(lines: string[], substring: string) {
  let lineCount = 0;
  let firstLineNumber: number | null = null;
  let firstLineText: string | null = null;

  lines.forEach((line, index) => {
    if (!line.includes(substring)) {
      return;
    }

    lineCount += 1;

    if (firstLineNumber === null) {
      firstLineNumber = index + 1;
      firstLineText = line;
    }
  });

  return {
    substring,
    lineCount,
    firstLineNumber,
    firstLineText,
  };
}
