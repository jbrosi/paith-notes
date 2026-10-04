import type Anthropic from '@anthropic-ai/sdk';

// Context passed to every tool handler. Mirrors the args the
// pre-registry executeTool() signature carried, just bundled so
// modules don't have to know which fields they need ahead of time.
export type ToolHandlerContext = {
  apiBaseUrl: string;
  cookie: string;
  nookId: string;
  memoryNookId?: string;
  /** Current conversation id — lets tools resolve per-turn state (e.g. the
   *  attached images stashed by the /chat route) without the model passing
   *  large payloads. */
  conversationId?: string;
  /** Model handling the current turn. Tools that hand the model pixels need it
   *  to check vision support BEFORE doing the work — on a text-only model the
   *  honest answer is a short text result, not a silently dropped image. */
  model?: string;
};

/**
 * What a tool hands back. A plain string is the common case and is stored
 * verbatim as the `tool_result` content. A block array is for tools that need
 * to put something richer than text in front of the model — `look_at_image`
 * returns a real Anthropic `image` block (the actual pixels) plus a short text
 * block describing what it's looking at, because a text-only result simply
 * cannot convey an image and would just invite the model to invent one.
 *
 * Narrowed to the block types a `tool_result` content actually accepts: sending
 * anything else (e.g. a tool_use block) would be rejected by the API.
 */
export type ToolResultBlocks = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

export type ToolResultContent = string | ToolResultBlocks;

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolResultContent>;

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
