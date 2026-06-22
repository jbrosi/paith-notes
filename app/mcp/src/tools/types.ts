import type Anthropic from '@anthropic-ai/sdk';

// Context passed to every tool handler. Mirrors the args the
// pre-registry executeTool() signature carried, just bundled so
// modules don't have to know which fields they need ahead of time.
export type ToolHandlerContext = {
  apiBaseUrl: string;
  cookie: string;
  nookId: string;
  memoryNookId?: string;
};

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<string>;

export type ToolModule = {
  // Stable identifier for logs. Doesn't have to match any tool name —
  // a module can register multiple tools under one identifier.
  name: string;
  // Module is loaded but its tools are only registered when enabled.
  // Typically a check on env vars at module load time. Tools that
  // return false here are completely invisible to the LLM (their
  // definitions are not sent in the system prompt).
  enabled: () => boolean;
  // Anthropic-format tool definitions. Names must match keys in handlers.
  definitions: Anthropic.Tool[];
  // Map of tool name → executor.
  handlers: Record<string, ToolHandler>;
  // Tool names that auto-approve (no user-approval modal). Read-only
  // operations should go here; anything that costs money or mutates
  // shared state should require approval.
  autoApproved?: string[];
};
