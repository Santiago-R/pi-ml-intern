// Type shims for Pi runtime modules. These are provided by Pi's runtime at
// execution time — the editor can't resolve them, so we declare minimal types.

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => any): void;
    registerTool(def: ToolDefinition): void;
    registerCommand(name: string, def: CommandDefinition): void;
    sendUserMessage(content: string | Array<{ type: string; [k: string]: unknown }>, opts?: Record<string, unknown>): void;
    getActiveTools(): { name: string }[];
  }
  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (u: unknown) => void, ctx?: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }
  export interface CommandDefinition {
    description: string;
    handler(args: string, ctx: ExtensionContext): Promise<void> | void;
  }
  export interface ExtensionContext {
    ui: {
      notify(msg: string, level?: "info" | "warning" | "error" | "success"): void;
      confirm(title: string, msg: string): Promise<boolean>;
      select(title: string, items: string[]): Promise<string | null>;
    };
    cwd: string;
    signal?: AbortSignal;
    sessionManager: {
      getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
      getSessionFile(): string;
    };
    isIdle(): boolean;
  }
}

declare module "@earendil-works/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): { enum: T; type: "string" };
}

declare module "typebox" {
  interface TSchema { [k: string]: unknown }
  export const Type: {
    Object<T extends Record<string, TSchema>>(props: T): { type: "object"; properties: T };
    String(opts?: Record<string, unknown>): { type: "string"; description?: string };
    Number(opts?: Record<string, unknown>): { type: "number"; description?: string };
    Boolean(opts?: Record<string, unknown>): { type: "boolean" };
    Optional<T extends TSchema>(schema: T): T;
    Array<T extends TSchema>(items: T, opts?: Record<string, unknown>): { type: "array"; items: T };
  };
}