import type { TodoState } from "./types";

export function buildPlanningPromptContext(
  todoState: TodoState | null | undefined,
) {
  return `## 任务计划

- 你可以使用 write_todos 维护当前线程的任务列表。
- 对多步骤、文件分析、报告产出、跨工具执行或可能耗时的任务，先写出 todo，再执行。
- 执行中只保留一个 in_progress；完成步骤后立刻把它改为 completed。
- 简单问答不要为了形式调用 write_todos。
- 如果任务无法继续，最终回答里解释阻塞原因；todo 状态只使用 pending、in_progress、completed。
${formatExistingTodoState(todoState)}`;
}

function formatExistingTodoState(todoState: TodoState | null | undefined) {
  if (!todoState || todoState.todos.length === 0) {
    return "\n当前线程暂无已有 todo 状态。";
  }

  const lines = todoState.todos.map(
    (todo) => `- ${todo.id}: [${todo.status}] ${todo.content}`,
  );

  return `\n当前线程已有 todo 状态（revision ${todoState.revision}）：\n${lines.join(
    "\n",
  )}`;
}
