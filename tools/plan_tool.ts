/**
 * plan_tool — In-memory task tracking. Exact replica of ml-intern's PlanTool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

let currentPlan: TodoItem[] = [];

export function getCurrentPlan(): TodoItem[] {
  return currentPlan;
}

export function registerPlanTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "plan_tool",
    label: "Plan",
    description:
      "Track progress on multi-step tasks with a todo list (pending/in_progress/completed).\n\n" +
      "Use for tasks with 3+ steps. Each call replaces the entire plan (send full list).\n\n" +
      "Rules: exactly ONE task in_progress at a time. Mark completed immediately after finishing. " +
      "Only mark completed when the task fully succeeded — keep in_progress if there are errors. " +
      "Update frequently so the user sees progress.",
    promptSnippet: "Track ML task progress (pending/in_progress/completed)",
    promptGuidelines: [
      "Use plan_tool to track progress on tasks with 3+ steps. Keep exactly one task in_progress, mark completed immediately, update frequently.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          id: Type.String(),
          content: Type.String(),
          status: StringEnum(["pending", "in_progress", "completed"] as const),
        }),
      ),
    }),
    async execute(_id, params) {
      const todos = params.todos as TodoItem[];
      const valid = ["pending", "in_progress", "completed"];

      for (const t of todos) {
        if (!t || typeof t !== "object")
          return err("Each todo must be an object.");
        if (!("id" in t)) return err("Missing 'id' field.");
        if (!("content" in t)) return err("Missing 'content' field.");
        if (!("status" in t)) return err("Missing 'status' field.");
        if (!valid.includes(t.status))
          return err(`Invalid status '${t.status}'. Use: ${valid.join(", ")}`);
      }

      currentPlan = [...todos];

      const icon = (s: string) =>
        s === "completed" ? "[✓]" : s === "in_progress" ? "[→]" : "[ ]";
      const lines = ["## Plan"];
      for (const t of todos) lines.push(`${icon(t.status)} ${t.id}: ${t.content}`);

      const done = todos.filter((t) => t.status === "completed").length;
      const prog = todos.filter((t) => t.status === "in_progress").length;
      const pend = todos.filter((t) => t.status === "pending").length;
      lines.push(
        "",
        `Progress: ${done}/${todos.length} done, ${prog} in_progress, ${pend} pending`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { todos: currentPlan, totalResults: todos.length },
      };
    },
  });
}

function err(msg: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${msg} Re-call the tool with correct format (mandatory).`,
      },
    ],
    details: { isError: true },
  };
}