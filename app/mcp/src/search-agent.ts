import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './chat-tools.js';

const MAX_SEARCH_DEPTH = 10;

// Read-only tools the search agent is allowed to use
const ALLOWED_TOOLS = new Set([
  'search_notes',
  'explore_notes',
  'get_note',
  'get_note_mentions',
  'list_note_types',
  'list_link_predicates',
  'memory_search',
  'memory_get',
]);

const SEARCH_AGENT_TOOLS = TOOLS.filter(t => ALLOWED_TOOLS.has(t.name));

function buildSearchAgentPrompt(nookId: string, nookName: string, context?: SearchAgentContext): string {
  const parts: string[] = [];

  parts.push(`You are a research assistant for a note-taking app called paith notes. You are searching notes in nook "${nookName}" (${nookId}).

Your job: search the user's notes efficiently and return a structured JSON report of what you found.

Search strategy (follow this order):
1. **Understand context first.** Before searching for the answer, search for context about the question itself. Use memory_search to understand who the user is, their preferences, and relevant background. If the task involves matching, comparing, or recommending — first establish what criteria matter by understanding the user's side, then search for candidates that match.
2. Start by calling list_note_types to see what types exist. If any types are clearly relevant to the task, filter by type_id first.
3. Use targeted keyword searches with search_notes — start narrow with specific terms.
4. If narrow searches return nothing relevant, do a second broader round: try shorter keywords, search_mode="or", or related terms.
5. NEVER use search_all_nooks. Only search the current nook and user memories. If you believe other nooks might have relevant information, mention it in your search_summary so the user can be asked.
6. Use explore_notes only when you have a specific starting note and need to discover its connections.

Reading discipline:
- Only read notes (get_note) that appeared in search results and look promising based on their title/snippet.
- Do NOT read notes "just to be thorough" — have a specific reason for each read.
- Do NOT scan all notes by leaving the search query empty. Always use keywords or type filters.
- Issue multiple independent tool calls in parallel when possible.
- Do NOT create, update, or delete anything. You are read-only.

When done, respond with ONLY a JSON object in this exact format (no markdown fences, no extra text):
{
  "findings": [
    {
      "note_id": "<full UUID>",
      "nook_id": "${nookId}",
      "note_title": "<title>",
      "relevance": "high" | "medium" | "low",
      "relevance_reason": "<why this note matters>",
      "excerpts": [
        {
          "text": "<the exact relevant fragment from the note>",
          "char_start": <character offset>,
          "char_end": <character offset>
        }
      ],
      "rest_summary": "<brief summary of what else is in this note>"
    }
  ],
  "search_summary": "<e.g. Searched 15 notes, read 6, found 3 relevant>",
  "notes_searched": <number>,
  "notes_read": <number>
}

Rules for findings:
- Rank by relevance (high first).
- Include excerpts with the exact text from the note content. Calculate char_start/char_end as character positions within the note content.
- rest_summary should briefly describe what else the note contains beyond the excerpts.
- If nothing relevant is found, return an empty findings array with an explanation in search_summary.
- Only include notes that are actually relevant to the task.`);

  if (context?.contextNote) {
    parts.push(`**Current note open in editor:**
Title: ${context.contextNote.title}
ID: ${context.contextNote.id}
Type: ${context.contextNote.type ?? 'note'}
When the task references "this note", "the current note", "my note", etc., it means this note.`);
  }

  if (context?.nookInstructions?.length) {
    const list = context.nookInstructions.map(n => `- "${n.title}" (ID: ${n.id})`).join('\n');
    parts.push(`**Nook-specific instructions** (read with get_note if relevant to the search task):\n${list}`);
  }

  if (context?.memoryNotes?.length) {
    const list = context.memoryNotes.map(n => `- "${n.title}" (ID: ${n.id})`).join('\n');
    parts.push(`**User memory notes** (read with memory_get if relevant):\n${list}`);
  }

  if (context?.conversationSummary) {
    parts.push(`**Conversation context:** ${context.conversationSummary}`);
  }

  return parts.join('\n\n');
}

export type SearchAgentProgress = (status: string) => void;

export type SearchAgentContext = {
  contextNote?: { id: string; title: string; type?: string };
  nookInstructions?: Array<{ id: string; title: string }>;
  memoryNotes?: Array<{ id: string; title: string }>;
  conversationSummary?: string;
};

export async function runSearchAgent(
  task: string,
  model: string,
  apiBase: string,
  cookie: string,
  nookId: string,
  nookName: string,
  memoryNookId?: string,
  onProgress?: SearchAgentProgress,
  context?: SearchAgentContext,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSearchAgentPrompt(nookId, nookName, context);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }];

  onProgress?.('Starting search...');

  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 4096,
        tools: SEARCH_AGENT_TOOLS,
        messages,
        system: systemPrompt,
      });
    } catch (err) {
      return JSON.stringify({
        findings: [],
        search_summary: `Search agent error: ${err instanceof Error ? err.message : 'unknown'}`,
        notes_searched: 0,
        notes_read: 0,
      });
    }

    if (response.stop_reason === 'end_turn') {
      // Extract the final text
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      const toolNames = toolBlocks.map(t => t.name);
      onProgress?.(`Using ${toolNames.join(', ')}... (step ${depth + 1})`);

      // Execute all tools in parallel
      const resultBlocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (t): Promise<Anthropic.ToolResultBlockParam> => {
          if (!ALLOWED_TOOLS.has(t.name)) {
            return { type: 'tool_result', tool_use_id: t.id, content: 'Tool not allowed in search agent.', is_error: true };
          }
          try {
            // Strip nook_id overrides — search agent is scoped to current nook only
            const sanitizedInput = { ...(t.input as Record<string, unknown>) };
            delete sanitizedInput.nook_id;
            const result = await executeTool(t.name, sanitizedInput, apiBase, cookie, nookId, memoryNookId);
            return { type: 'tool_result', tool_use_id: t.id, content: result };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: t.id, content: `Error: ${err instanceof Error ? err.message : 'unknown'}`, is_error: true };
          }
        }),
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: resultBlocks });
    }
  }

  // Depth limit reached — ask for final summary
  onProgress?.('Compiling results...');
  try {
    const finalResponse = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        ...messages,
        { role: 'user', content: 'You have reached the search depth limit. Please compile and return your findings now in the required JSON format, based on everything you have found so far.' },
      ],
      system: systemPrompt,
    });
    const text = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    return text;
  } catch {
    return JSON.stringify({
      findings: [],
      search_summary: 'Search agent reached depth limit and failed to compile results.',
      notes_searched: 0,
      notes_read: 0,
    });
  }
}
