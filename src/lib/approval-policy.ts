import {
  deleteFilesystemFile,
  editFilesystemFile,
  previewFilesystemDelete,
  previewFilesystemEdit,
  previewFilesystemWrite,
  writeFilesystemFile,
  type DeleteFilesystemFileResult,
  type EditFilesystemFileResult,
  type WriteFilesystemFileResult,
} from "@/lib/agent/services/filesystem-service";
import {
  deleteUserMemory,
  saveUserMemory,
  type DeleteUserMemoryResult,
  type SaveUserMemoryResult,
} from "@/lib/agent/services/memory-service";
import {
  validateExecuteCommandArgs as validateExecuteCommandArgsFromPolicy,
} from "@/lib/command-execution/command-policy";
import {
  executeCommandInSandbox,
  prepareCommandApprovalPreview,
} from "@/lib/command-execution/execution-service";
import type { CommandExecutionToolResult } from "@/lib/command-execution/contracts";
import {
  type ApprovalGatedToolName,
  type ApprovalOption,
  type ApprovalPreview,
} from "@/lib/approval-actions";
import { previewSaveMemory } from "@/lib/server/memory-store";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";

export type ApprovalContext = {
  threadId: string;
  threadScope: ThreadScope;
};

export type ApprovalToolMutationResult =
  | DeleteFilesystemFileResult
  | EditFilesystemFileResult
  | WriteFilesystemFileResult
  | DeleteUserMemoryResult
  | SaveUserMemoryResult
  | CommandExecutionToolResult;

type ValidationSuccess = {
  ok: true;
  value: Record<string, unknown>;
};

type ValidationFailure = {
  ok: false;
  message: string;
};

export type ApprovalValidationResult = ValidationSuccess | ValidationFailure;

export type ApprovalPolicy = {
  label: string;
  preparePreview(
    args: Record<string, unknown>,
    context: ApprovalContext,
  ): Promise<ApprovalPreview | undefined>;
  supportsEditArgs: boolean;
  toolName: ApprovalGatedToolName;
  validateArgs(args: unknown): ApprovalValidationResult;
  execute(
    args: Record<string, unknown>,
    context: ApprovalContext,
  ): Promise<ApprovalToolMutationResult>;
};

const approvalPolicies: Record<ApprovalGatedToolName, ApprovalPolicy> = {
  save_memory: {
    label: "保存记忆",
    preparePreview: async (args, context) => {
      const input = validateSaveMemoryArgs(args);
      if (!input.ok) {
        return undefined;
      }

      return (
        (await previewSaveMemory(context.threadScope, {
          category: input.value.category as string,
          content: input.value.content as string,
        })) ?? undefined
      );
    },
    supportsEditArgs: true,
    toolName: "save_memory",
    validateArgs: validateSaveMemoryArgs,
    execute: (args, context) => {
      const input = validateSaveMemoryArgs(args);
      if (!input.ok) {
        return Promise.resolve(createInvalidToolArgsResult(input.message));
      }

      return saveUserMemory(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          category: input.value.category as string,
          content: input.value.content as string,
          ...(input.value.metadata
            ? { metadata: input.value.metadata as Record<string, unknown> }
            : {}),
        },
      );
    },
  },
  delete_memory: {
    label: "删除记忆",
    preparePreview: async () => undefined,
    supportsEditArgs: true,
    toolName: "delete_memory",
    validateArgs: validateDeleteMemoryArgs,
    execute: (args, context) => {
      const input = validateDeleteMemoryArgs(args);
      if (!input.ok) {
        return Promise.resolve(createInvalidToolArgsResult(input.message));
      }

      return deleteUserMemory(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        input.value.memoryId as string,
      );
    },
  },
  write_file: {
    label: "写入文件",
    preparePreview: async (args, context) => {
      const input = validateWriteFileArgs(args);
      if (!input.ok) {
        return undefined;
      }

      const result = await previewFilesystemWrite(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          content: input.value.content as string,
          path: input.value.path as string,
        },
      );
      if (!result.ok) {
        throw new Error(`无法生成写入文件预览：${result.error.message}`);
      }
      return result.preview;
    },
    supportsEditArgs: true,
    toolName: "write_file",
    validateArgs: validateWriteFileArgs,
    execute: (args, context) => {
      const input = validateWriteFileArgs(args);
      if (!input.ok) {
        return Promise.resolve(createInvalidToolArgsResult(input.message));
      }

      return writeFilesystemFile(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          content: input.value.content as string,
          path: input.value.path as string,
        },
      );
    },
  },
  edit_file: {
    label: "编辑文件",
    preparePreview: async (args, context) => {
      const input = validateEditFileArgs(args);
      if (!input.ok) {
        return undefined;
      }

      const result = await previewFilesystemEdit(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          newText: input.value.newText as string,
          oldText: input.value.oldText as string,
          path: input.value.path as string,
          replaceAll: input.value.replaceAll === true,
        },
      );
      if (!result.ok) {
        throw new Error(`无法生成编辑文件预览：${result.error.message}`);
      }
      return result.preview;
    },
    supportsEditArgs: true,
    toolName: "edit_file",
    validateArgs: validateEditFileArgs,
    execute: (args, context) => {
      const input = validateEditFileArgs(args);
      if (!input.ok) {
        return Promise.resolve(createInvalidToolArgsResult(input.message));
      }

      return editFilesystemFile(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          newText: input.value.newText as string,
          oldText: input.value.oldText as string,
          path: input.value.path as string,
          ...(typeof input.value.replaceAll === "boolean"
            ? { replaceAll: input.value.replaceAll }
            : {}),
        },
      );
    },
  },
  delete_file: {
    label: "删除文件",
    preparePreview: async (args, context) => {
      const input = validateDeleteFileArgs(args);
      if (!input.ok) {
        return undefined;
      }

      const result = await previewFilesystemDelete(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          path: input.value.path as string,
        },
      );
      if (!result.ok) {
        throw new Error(`无法生成删除文件预览：${result.error.message}`);
      }
      return result.preview;
    },
    supportsEditArgs: true,
    toolName: "delete_file",
    validateArgs: validateDeleteFileArgs,
    execute: (args, context) => {
      const input = validateDeleteFileArgs(args);
      if (!input.ok) {
        return Promise.resolve(createInvalidToolArgsResult(input.message));
      }

      return deleteFilesystemFile(
        {
          threadId: context.threadId,
          threadScope: context.threadScope,
        },
        {
          path: input.value.path as string,
        },
      );
    },
  },
  execute_command: {
    label: "执行命令",
    preparePreview: async (args, context) =>
      prepareCommandApprovalPreview(args, context),
    supportsEditArgs: true,
    toolName: "execute_command",
    validateArgs: validateExecuteCommandArgs,
    execute: (args, context) => executeCommandInSandbox(args, context),
  },
};

export function getApprovalPolicy(toolName: string) {
  return isApprovalPolicyToolName(toolName)
    ? approvalPolicies[toolName]
    : undefined;
}

export function isApprovalPolicyToolName(
  toolName: string,
): toolName is ApprovalGatedToolName {
  return Object.prototype.hasOwnProperty.call(approvalPolicies, toolName);
}

export async function prepareApprovalAction({
  args,
  context,
  toolName,
}: {
  args: unknown;
  context: ApprovalContext;
  toolName: ApprovalGatedToolName;
}) {
  const policy = approvalPolicies[toolName];
  const validation = policy.validateArgs(args);
  if (!validation.ok) {
    return {
      validationError: validation.message,
      requiresApproval: false as const,
    };
  }

  return {
    preview: await policy.preparePreview(validation.value, context),
    requiresApproval: true as const,
  };
}

export async function executeApprovalTool({
  args,
  context,
  toolName,
}: {
  args: unknown;
  context: ApprovalContext;
  toolName: ApprovalGatedToolName;
}) {
  const policy = approvalPolicies[toolName];
  const validation = policy.validateArgs(args);
  if (!validation.ok) {
    return createInvalidToolArgsResult(validation.message);
  }

  return policy.execute(validation.value, context);
}

export function createApprovalOptions(
  toolName: ApprovalGatedToolName,
): ApprovalOption[] {
  const policy = approvalPolicies[toolName];
  const options: ApprovalOption[] = [
    {
      description: "只允许本次工具调用执行。",
      id: "approve-once",
      kind: "allow-once",
      label: `确认${policy.label}`,
    },
  ];

  if (policy.supportsEditArgs) {
    options.push({
      description: "修改参数后执行本次工具调用。",
      id: "edit-and-execute",
      kind: "_edit_args",
      label: "修改参数并执行",
    });
  }

  options.push(
    {
      description: "不执行当前操作，并提供下一步指导。",
      id: "provide-guidance",
      kind: "_guidance",
      label: "提供指导",
    },
    {
      description: getApprovalRejectDescription(toolName),
      id: "reject-once",
      kind: "reject-once",
      label: "取消",
    },
  );

  return options;
}

export function getApprovalActionLabel(toolName: ApprovalGatedToolName) {
  return approvalPolicies[toolName].label;
}

export function getApprovalSubject(toolName: ApprovalGatedToolName) {
  return toolName === "save_memory" || toolName === "delete_memory"
    ? "记忆操作"
    : toolName === "execute_command"
      ? "命令执行"
      : "文件操作";
}

export function createInvalidToolArgsResult(message: string) {
  return {
    error: {
      code: "invalid_tool_args",
      message,
    },
    ok: false as const,
    summary: `确认请求参数无效：${message}`,
  };
}

function validateSaveMemoryArgs(args: unknown): ApprovalValidationResult {
  if (!isRecord(args)) {
    return { message: "save_memory 参数必须是对象。", ok: false };
  }

  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return {
      message: "save_memory.content must be a non-empty string.",
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      category:
        typeof args.category === "string" && args.category.trim()
          ? args.category.trim()
          : "general",
      content,
      ...(isRecord(args.metadata) ? { metadata: args.metadata } : {}),
    },
  };
}

function validateDeleteMemoryArgs(args: unknown): ApprovalValidationResult {
  if (!isRecord(args)) {
    return { message: "delete_memory 参数必须是对象。", ok: false };
  }

  const memoryId = typeof args.memoryId === "string" ? args.memoryId.trim() : "";
  return memoryId
    ? { ok: true, value: { memoryId } }
    : {
        message: "delete_memory.memoryId must be a non-empty string.",
        ok: false,
      };
}

function validateWriteFileArgs(args: unknown): ApprovalValidationResult {
  if (!isRecord(args)) {
    return { message: "write_file 参数必须是对象。", ok: false };
  }

  const path = normalizeNonEmptyString(args.path);
  if (!path) {
    return { message: "write_file.path must be a non-empty string.", ok: false };
  }

  return typeof args.content === "string"
    ? { ok: true, value: { content: args.content, path } }
    : { message: "write_file.content must be a string.", ok: false };
}

function validateEditFileArgs(args: unknown): ApprovalValidationResult {
  if (!isRecord(args)) {
    return { message: "edit_file 参数必须是对象。", ok: false };
  }

  const path = normalizeNonEmptyString(args.path);
  if (!path) {
    return { message: "edit_file.path must be a non-empty string.", ok: false };
  }

  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  if (!oldText) {
    return {
      message: "edit_file.oldText must be a non-empty string.",
      ok: false,
    };
  }

  return typeof args.newText === "string"
    ? {
        ok: true,
        value: {
          newText: args.newText,
          oldText,
          path,
          ...(typeof args.replaceAll === "boolean"
            ? { replaceAll: args.replaceAll }
            : {}),
        },
      }
    : { message: "edit_file.newText must be a string.", ok: false };
}

function validateDeleteFileArgs(args: unknown): ApprovalValidationResult {
  if (!isRecord(args)) {
    return { message: "delete_file 参数必须是对象。", ok: false };
  }

  const path = normalizeNonEmptyString(args.path);
  return path
    ? { ok: true, value: { path } }
    : { message: "delete_file.path must be a non-empty string.", ok: false };
}

function validateExecuteCommandArgs(args: unknown): ApprovalValidationResult {
  return validateCommandArgs(args);
}

function validateCommandArgs(args: unknown): ApprovalValidationResult {
  // The command service owns the allowlist and path checks so the agent,
  // approval API, and edited-argument flow all share the same validation.
  // Keep the adapter here to preserve the approval registry's common shape.
  const result = validateExecuteCommandArgsFromPolicy(args);
  return result.ok
    ? { ok: true, value: result.value }
    : { message: result.message, ok: false };
}

function getApprovalRejectDescription(toolName: ApprovalGatedToolName) {
  return toolName === "save_memory" || toolName === "delete_memory"
    ? "取消本次工具调用，不修改长期记忆。"
    : "取消本次工具调用，不修改文件。";
}

function normalizeNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
