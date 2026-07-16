export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;

type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = {
  content: string;
  id: string;
  status: TodoStatus;
};

export type TodoState = {
  agentId: string;
  revision: number;
  todos: TodoItem[];
  updatedAt: string;
};

export type TodoInputItem = {
  content: string;
  id?: string;
  status: TodoStatus;
};

export type TodoWriteResult =
  | {
      ok: true;
      state: TodoState;
      summary: string;
    }
  | {
      error: {
        code: string;
        message: string;
      };
      ok: false;
      summary: string;
    };
