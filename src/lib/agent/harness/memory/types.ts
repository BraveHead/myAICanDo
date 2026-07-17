import type { TodoState } from "../planning";

export type MemoryManifest = {
  schemaVersion: 1;
  user: MemoryEntry[];
  project: MemoryEntry[];
  harness: HarnessMemory;
};

export type MemoryEntry = {
  id: string;
  source: "memory-store" | "project-file";
  content: string;
  key?: string;
  path?: string;
  updatedAt?: string;
};

export type HarnessMemory = {
  threadId: string;
  todoState?: TodoState | null;
  offloadReferences?: string[];
};
