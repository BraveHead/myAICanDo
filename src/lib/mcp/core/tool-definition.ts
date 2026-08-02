import type {
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { TrustedMcpThreadAccess } from "../access/policy";

export const readonlyToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const satisfies ToolAnnotations;

export type McpToolAccess = {
  kind: "thread";
};

export type McpToolExecutionContext = {
  requestId: string;
  trustedScope: TrustedMcpThreadAccess;
};

export type McpToolDefinition = {
  access: McpToolAccess;
  annotations: ToolAnnotations;
  description: string;
  execute(
    input: unknown,
    context: McpToolExecutionContext,
  ): Promise<Record<string, unknown>>;
  inputSchema: StandardSchemaWithJSON;
  name: string;
  outputSchema: StandardSchemaWithJSON;
  title: string;
};

type TypedMcpToolDefinition<
  InputSchema extends StandardSchemaWithJSON,
  OutputSchema extends StandardSchemaWithJSON,
> = Omit<
  McpToolDefinition,
  "execute" | "inputSchema" | "outputSchema"
> & {
  execute(
    input: StandardSchemaWithJSON.InferOutput<InputSchema>,
    context: McpToolExecutionContext,
  ): Promise<Record<string, unknown>>;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
};

export function defineMcpTool<
  InputSchema extends StandardSchemaWithJSON,
  OutputSchema extends StandardSchemaWithJSON,
>(
  definition: TypedMcpToolDefinition<InputSchema, OutputSchema>,
): McpToolDefinition {
  return {
    ...definition,
    execute: (input, context) =>
      definition.execute(
        input as StandardSchemaWithJSON.InferOutput<InputSchema>,
        context,
      ),
  };
}
