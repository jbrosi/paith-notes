import type Anthropic from '@anthropic-ai/sdk';
import { imageGenTools } from './image-gen.js';
import type { ToolHandler, ToolHandlerContext, ToolModule } from './types.js';
import { weatherTools } from './weather.js';
import { wikipediaTools } from './wikipedia.js';

// Add a module here to register a new optional tool group. Each module
// self-gates via its `enabled()` getter (typically a check on env vars
// at module load time). Modules that report disabled contribute zero
// tool definitions and zero handlers — the LLM never sees them in the
// system prompt and the handlers map can't dispatch to them.
const ALL_MODULES: ToolModule[] = [weatherTools, wikipediaTools, imageGenTools];

const ENABLED_MODULES = ALL_MODULES.filter((m) => m.enabled());

export const optionalToolDefinitions: Anthropic.Tool[] = ENABLED_MODULES.flatMap(
  (m) => m.definitions,
);

const handlersMap = new Map<string, ToolHandler>();
for (const mod of ENABLED_MODULES) {
  for (const [name, handler] of Object.entries(mod.handlers)) {
    if (handlersMap.has(name)) {
      throw new Error(`tool registry: duplicate handler for "${name}" (in module ${mod.name})`);
    }
    handlersMap.set(name, handler);
  }
}

export function getOptionalToolHandler(name: string): ToolHandler | undefined {
  return handlersMap.get(name);
}

export const optionalAutoApprovedTools = new Set<string>(
  ENABLED_MODULES.flatMap((m) => m.autoApproved ?? []),
);

// Log once at module load so operators can sanity-check which optional
// tool groups got registered for this MCP process.
const summary = ENABLED_MODULES.map(
  (m) => `${m.name}(${m.definitions.map((d) => d.name).join(',')})`,
).join(' ');
console.log(`[tools] optional modules: ${summary || '(none enabled)'}`);

// Re-export the context type so downstream callers don't have to know
// the module layout.
export type { ToolHandlerContext };
