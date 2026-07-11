import { tool } from "langchain";
import * as z from "zod";
import {
  FILESYSTEM_MAX_SEARCH_RESULTS,
  listFilesystemDirectory,
  readFilesystemFile,
  searchFilesystemText,
} from "@/lib/agent/services/filesystem-service";
import { queryUserMemories } from "@/lib/agent/services/memory-service";
import { getWeatherForCity } from "@/lib/agent/services/weather-service";
import type { AgentToolContext } from "@/lib/agent/core/agent-definition";

type DelegateName = "filesystem" | "memory" | "weather";

type DelegateResult = {
  data?: unknown;
  delegate: DelegateName;
  error?: {
    code: string;
    message: string;
  };
  ok: boolean;
  summary: string;
};

export function createCoordinatorTools(context: AgentToolContext) {
  return [
    tool(
      async ({ limit = 20, query }) =>
        jsonResult(
          toDelegateResult(
            "memory",
            await queryUserMemories(context, {
              limit,
              query,
            }),
          ),
        ),
      {
        name: "ask_memory_agent",
        description:
          "Read the current tenant/user long-term memories. This coordinator v1 tool is read-only and cannot save or delete memories.",
        schema: z.object({
          query: z
            .string()
            .max(200)
            .optional()
            .describe("Optional keyword used to search saved memory content/category."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of memories to return."),
        }),
      },
    ),
    tool(
      async ({
        action,
        caseSensitive = false,
        maxResults = FILESYSTEM_MAX_SEARCH_RESULTS,
        path = ".",
        query,
      }) => {
        if (action === "list") {
          return jsonResult(
            toDelegateResult(
              "filesystem",
              await listFilesystemDirectory(context, path),
            ),
          );
        }

        if (action === "read") {
          return jsonResult(
            toDelegateResult("filesystem", await readFilesystemFile(context, path)),
          );
        }

        if (!query?.trim()) {
          return jsonResult(
            createDelegateError(
              "filesystem",
              "missing_query",
              "search action requires a non-empty query.",
            ),
          );
        }

        return jsonResult(
          toDelegateResult(
            "filesystem",
            await searchFilesystemText(context, {
              caseSensitive,
              maxResults,
              path,
              query,
            }),
          ),
        );
      },
      {
        name: "ask_filesystem_agent",
        description:
          "Read-only access to the current thread filesystem sandbox. Use list for directories, read for UTF-8 text files, and search for text search.",
        schema: z.object({
          action: z
            .enum(["list", "read", "search"])
            .describe("Filesystem action to perform."),
          path: z
            .string()
            .optional()
            .describe("Relative path inside the current thread sandbox."),
          query: z
            .string()
            .max(200)
            .optional()
            .describe("Required only when action is search."),
          caseSensitive: z
            .boolean()
            .optional()
            .describe("Whether search matching should be case-sensitive."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(FILESYSTEM_MAX_SEARCH_RESULTS)
            .optional()
            .describe("Maximum number of search matches to return."),
        }),
      },
    ),
    tool(
      async ({ city }) =>
        jsonResult(toDelegateResult("weather", getWeatherForCity(city))),
      {
        name: "ask_weather_agent",
        description: "Get weather information for a city using the weather delegate.",
        schema: z.object({
          city: z.string().min(1).max(120).describe("The city to get weather for."),
        }),
      },
    ),
  ];
}

function toDelegateResult(
  delegate: DelegateName,
  result: { error?: { code: string; message: string }; ok: boolean; summary: string },
): DelegateResult {
  if (!result.ok) {
    return {
      ok: false,
      delegate,
      summary: result.summary,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  return {
    ok: true,
    delegate,
    summary: result.summary,
    data: result,
  };
}

function createDelegateError(
  delegate: DelegateName,
  code: string,
  message: string,
): DelegateResult {
  return {
    ok: false,
    delegate,
    summary: `${delegate} delegate error: ${code}, ${message}`,
    error: {
      code,
      message,
    },
  };
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
