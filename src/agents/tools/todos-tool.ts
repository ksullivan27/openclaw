import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoItemStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoState {
  sessionId: string;
  title?: string;
  items: TodoItem[];
  nextId: number;
  binding?: {
    kb?: { path: string; title: string; section?: string };
  };
  finished?: boolean;
  finishReason?: string;
  lastCompletedAt?: string;
  updatedAt: string;
}

export type TodoStats = {
  pending: number;
  in_progress: number;
  blocked: number;
  completed: number;
  total: number;
};

const TODO_ACTIONS = [
  "list",
  "set",
  "add",
  "remove",
  "start",
  "complete",
  "finish",
  "block",
  "unblock",
  "bind",
  "clear",
] as const;

const TodosToolSchema = Type.Object({
  action: stringEnum(TODO_ACTIONS),
  items: Type.Optional(Type.Array(Type.String())),
  title: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  kbTitle: Type.Optional(Type.String()),
  section: Type.Optional(Type.String()),
});

const TODO_STATE_BY_SESSION_ID = new Map<string, TodoState>();

function nowIso() {
  return new Date().toISOString();
}

function buildEmptyState(sessionId: string): TodoState {
  return {
    sessionId,
    items: [],
    nextId: 1,
    updatedAt: nowIso(),
  };
}

function getOrCreateState(sessionId: string): TodoState {
  const existing = TODO_STATE_BY_SESSION_ID.get(sessionId);
  if (existing) {
    return existing;
  }
  const next = buildEmptyState(sessionId);
  TODO_STATE_BY_SESSION_ID.set(sessionId, next);
  return next;
}

export function getTodosState(sessionId: string): TodoState | undefined {
  return TODO_STATE_BY_SESSION_ID.get(sessionId);
}

export function computeStats(items: TodoItem[]): TodoStats {
  const stats: TodoStats = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    completed: 0,
    total: items.length,
  };
  for (const item of items) {
    stats[item.status] += 1;
  }
  return stats;
}

export function isAllDone(items: TodoItem[]): boolean {
  return items.length > 0 && items.every((item) => item.status === "completed");
}

function renderTodoListMarkdown(state: TodoState): string {
  const lines: string[] = [];
  const stats = computeStats(state.items);
  const allDone = isAllDone(state.items);
  const kbFinalizeSuggested = allDone && state.binding?.kb != null;

  lines.push("## Todos");
  if (state.title?.trim()) {
    lines.push(`**Title:** ${state.title.trim()}`);
  }
  const kb = state.binding?.kb;
  if (kb) {
    const section = kb.section?.trim() ? ` (${kb.section.trim()})` : "";
    lines.push(`**KB:** ${kb.title} — \`${kb.path}\`${section}`);
  }
  lines.push(
    `**Stats:** ${stats.total} total · ${stats.pending} pending · ${stats.in_progress} in_progress · ${stats.blocked} blocked · ${stats.completed} completed`,
  );
  lines.push("");

  if (state.items.length === 0) {
    lines.push("_No todos set._");
  } else {
    for (const item of state.items) {
      const checkbox = item.status === "completed" ? "x" : " ";
      const statusSuffix =
        item.status === "pending" || item.status === "completed"
          ? ""
          : item.status === "blocked"
            ? ` _(blocked${item.reason?.trim() ? `: ${item.reason.trim()}` : ""})_`
            : " _(in_progress)_";
      lines.push(`- [${checkbox}] \`#${item.id}\` ${item.text}${statusSuffix}`);
    }
  }

  if (allDone) {
    lines.push("");
    lines.push(
      kbFinalizeSuggested ? "All todos completed. KB finalize suggested." : "All todos completed.",
    );
  }

  return lines.join("\n");
}

function findItemOrThrow(state: TodoState, id: number): TodoItem {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) {
    throw new ToolInputError(`Unknown todo id: ${id}`);
  }
  return item;
}

function touchState(state: TodoState) {
  state.updatedAt = nowIso();
}

function touchItem(item: TodoItem) {
  item.updatedAt = nowIso();
}

function normalizeTodoTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ToolInputError("items required");
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readTodoId(params: Record<string, unknown>): number {
  const id = readNumberParam(params, "id", { required: true, integer: true });
  if (id === undefined) {
    throw new ToolInputError("id required");
  }
  return id;
}

export function createTodosTool(options?: { sessionId?: string }): AnyAgentTool {
  return {
    label: "Todos",
    name: "todos",
    description: "Track execution steps for the current task (session-scoped).",
    parameters: TodosToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionId = options?.sessionId?.trim();
      if (!sessionId) {
        throw new ToolInputError("sessionId required");
      }

      const action = readStringParam(params, "action", { required: true });
      const state =
        action === "list"
          ? (TODO_STATE_BY_SESSION_ID.get(sessionId) ?? buildEmptyState(sessionId))
          : getOrCreateState(sessionId);

      switch (action) {
        case "list":
          break;
        case "set": {
          const title = readStringParam(params, "title", { trim: true });
          if (title !== undefined) {
            state.title = title;
          }
          state.finished = false;
          state.finishReason = undefined;
          state.lastCompletedAt = undefined;
          state.binding = undefined;
          const texts = normalizeTodoTexts(params.items);
          const createdAt = nowIso();
          state.items = texts.map((text, idx) => ({
            id: idx + 1,
            text,
            status: "pending",
            createdAt,
            updatedAt: createdAt,
          }));
          state.nextId = state.items.length + 1;
          touchState(state);
          break;
        }
        case "add": {
          const text = readStringParam(params, "text", { required: true });
          const ts = nowIso();
          state.items.push({
            id: state.nextId,
            text,
            status: "pending",
            createdAt: ts,
            updatedAt: ts,
          });
          state.nextId += 1;
          touchState(state);
          break;
        }
        case "remove": {
          const id = readTodoId(params);
          const index = state.items.findIndex((entry) => entry.id === id);
          if (index === -1) {
            throw new ToolInputError(`Unknown todo id: ${id}`);
          }
          state.items.splice(index, 1);
          touchState(state);
          break;
        }
        case "start": {
          const id = readTodoId(params);
          const next = findItemOrThrow(state, id);
          if (next.status === "completed") {
            throw new ToolInputError(`Todo #${id} is already completed`);
          }
          if (next.status === "blocked") {
            throw new ToolInputError(`Todo #${id} is blocked — unblock it first`);
          }
          for (const item of state.items) {
            if (item.id !== id && item.status === "in_progress") {
              item.status = "pending";
              touchItem(item);
            }
          }
          next.status = "in_progress";
          next.reason = undefined;
          touchItem(next);
          touchState(state);
          break;
        }
        case "complete": {
          const id = readTodoId(params);
          const item = findItemOrThrow(state, id);
          item.status = "completed";
          item.reason = undefined;
          touchItem(item);
          state.lastCompletedAt = nowIso();
          touchState(state);
          break;
        }
        case "finish": {
          const reason = readStringParam(params, "reason", { trim: true });
          state.finished = true;
          state.finishReason = reason?.trim() || undefined;
          touchState(state);
          break;
        }
        case "block": {
          const id = readTodoId(params);
          const item = findItemOrThrow(state, id);
          if (item.status === "completed") {
            throw new ToolInputError(`Todo #${id} is already completed`);
          }
          const reason = readStringParam(params, "reason", { trim: true, allowEmpty: true });
          item.status = "blocked";
          if (reason !== undefined) {
            item.reason = reason.trim() ? reason.trim() : undefined;
          }
          touchItem(item);
          touchState(state);
          break;
        }
        case "unblock": {
          const id = readTodoId(params);
          const item = findItemOrThrow(state, id);
          if (item.status !== "blocked") {
            throw new ToolInputError(`Todo #${id} is not blocked`);
          }
          item.status = "pending";
          item.reason = undefined;
          touchItem(item);
          touchState(state);
          break;
        }
        case "bind": {
          const path = readStringParam(params, "path", { required: true });
          const kbTitle = readStringParam(params, "kbTitle", { required: true, label: "kbTitle" });
          const section = readStringParam(params, "section", { trim: true });
          state.binding = {
            kb: {
              path,
              title: kbTitle,
              ...(section ? { section } : {}),
            },
          };
          touchState(state);
          break;
        }
        case "clear":
          TODO_STATE_BY_SESSION_ID.delete(sessionId);
          break;
        default:
          throw new ToolInputError(`Unknown action: ${action}`);
      }

      const latest = action === "clear" ? buildEmptyState(sessionId) : state;
      const stats = computeStats(latest.items);
      const allDone = isAllDone(latest.items);
      const binding = latest.binding;
      const kbFinalizeSuggested = allDone && binding?.kb != null;

      return {
        content: [{ type: "text", text: renderTodoListMarkdown(latest) }],
        details: {
          items: latest.items,
          stats,
          ...(binding ? { binding } : {}),
          allDone,
          kbFinalizeSuggested,
        },
      };
    },
  };
}
