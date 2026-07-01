import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './chat-tools.js';
import { mapWithConcurrency } from './concurrency.js';

/**
 * Edit-focused sub-agent — same shape as search_agent but scoped to
 * working on a single note. Spawned via the `edit_note_agent` tool.
 *
 * Why: when the AI needs to make non-trivial edits, the read-then-edit
 * loop pollutes the main conversation with the full note content,
 * even though the user only cares about the resulting summary. This
 * agent runs the read+edit loop in its own context window and returns
 * just a brief summary to the main conversation.
 *
 * Context modes:
 *   • inherit — the agent's prompt prefix is the main conversation's
 *     prefix (cached, ~free), giving the agent full backstory. The
 *     system prompt is the main system prompt verbatim (preserves
 *     cache hit on the largest block). The agent's "task" is appended
 *     as a synthetic user turn at the end. Best when the user gave
 *     loose instructions across several turns and disambiguation
 *     requires history.
 *
 *   • fresh — minimal scoped system prompt + just the task. Best when
 *     the task is fully self-contained (rename X to Y, fix typo). No
 *     cache hit on the prefix, but the prompt itself is small.
 */

const MAX_EDIT_DEPTH = 10;

// Tools the edit agent is allowed to use. Read tools so it can look at
// the note before editing; edit tools to do the work; ask_user to
// clarify the rare ambiguity. Deliberately no cross-nook search, no
// schema changes, no delegation-to-another-agent, no image gen.
const ALLOWED_TOOLS = new Set([
  'get_note',
  'get_note_summary',
  'get_note_section',
  'get_note_toc',
  'get_note_part',
  'read_note_lines',
  'search_in_note',
  'get_note_mentions',
  'get_note_history',
  'get_note_version',
  'compare_note_versions',
  'list_type_attributes',
  'edit_note',
  'update_note',
  'ask_user',
]);

const EDIT_AGENT_TOOLS = TOOLS.filter(t => ALLOWED_TOOLS.has(t.name));

const FRESH_SYS_PROMPT = `You are a focused sub-agent in a note-taking app. You have been spawned with ONE job: complete the editing task you'll be given on a single note. Use your tools to read the note as needed, plan your edits, apply them, and then END YOUR TURN with a brief (1-3 sentence) plain-text summary of what you did. Do not chat. Do not narrate. Just do the work and report back.

Hard rules:
- Stay on the specific note you were given. Do not wander.
- Prefer edit_note (surgical) over update_note (full rewrite). Use update_note only when the change is too structural for string substitution.
- Pass expected_version from a get_note read so concurrent edits are detected.
- If the task is genuinely ambiguous in a way that affects what you'd write, use ask_user. Do not silently guess on high-stakes edits.
- If the note is large, get_note_toc first to navigate, then read just the relevant chunks via get_note_part or read_note_lines — don't pull the whole body when you don't need to.
- Your final message must be plain text, no markdown, no JSON, no fences. The main assistant will relay it verbatim to the user.`;

const INHERIT_TASK_PREAMBLE = `[INTERNAL — sub-agent task]

You are continuing the conversation above as a focused sub-agent. The main assistant has delegated ONE task to you so the read+edit loop doesn't pollute the main conversation's context.

Hard rules for this delegation:
- Complete ONLY the task below. Do not wander.
- Prefer edit_note (surgical) over update_note (full rewrite).
- Pass expected_version from a get_note read so concurrent edits are detected.
- If the task is genuinely ambiguous in a way that affects what you'd write, use ask_user. Do not silently guess on high-stakes edits.
- If the note is large, get_note_toc first to navigate, then read just the relevant chunks.
- Your final message MUST be plain text, 1-3 sentences, no markdown, no JSON. It will be relayed verbatim to the user as the result of the delegation.

Task: `;

export type EditAgentProgress = (status: string) => void;

export type EditAgentRunOptions = {
  task: string;
  noteId: string;
  nookId: string;
  contextMode: 'inherit' | 'fresh';
  model: string;
  apiBase: string;
  cookie: string;
  memoryNookId?: string;
  onProgress?: EditAgentProgress;
  /** Required when contextMode === 'inherit'. The main conversation's
   *  base system prompt — sub-agent uses the SAME text so the prompt
   *  cache hits on it. */
  mainSystemPrompt?: string;
  /** Required when contextMode === 'inherit'. Main conversation's
   *  messages array up to and NOT including the assistant turn that
   *  emitted the delegate call. Sub-agent inherits this as prefix.
   *  Must end on an assistant turn — if the most recent main message
   *  was a user turn (typically the case when this fires from auto-
   *  execute), trim that off and pass the user's text in via `task`
   *  instead. */
  mainMessages?: Anthropic.MessageParam[];
};

/**
 * Build the messages array for an `inherit`-mode agent run.
 *
 * The prefix is the main conversation's messages up to the last
 * assistant turn (the most recent fully-resolved boundary). The
 * synthetic user turn appended at the end carries:
 *   • the delegated task (verbatim from the spawning tool call's
 *     `task` input)
 *   • the user's most recent text (if their last message was a user
 *     turn — i.e. it came after the last assistant boundary and isn't
 *     in the cached prefix), so the agent sees the immediate request
 *     it's being asked to help with
 *
 * The result is a valid alternating user/assistant sequence ending on
 * a user turn, ready to send to the model.
 */
export function buildInheritMessages(
  mainMessages: Anthropic.MessageParam[],
  task: string,
): Anthropic.MessageParam[] {
  // Find the index of the last assistant message. We cut the prefix
  // there to guarantee clean turn alternation when we append our
  // synthetic user turn. Anything after it is text from the user that
  // hasn't been "answered" yet — we fold that into the task.
  let lastAssistantIdx = -1;
  for (let i = mainMessages.length - 1; i >= 0; i--) {
    if (mainMessages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  const prefix = lastAssistantIdx >= 0
    ? mainMessages.slice(0, lastAssistantIdx + 1)
    : [];

  // Anything after the last assistant turn = user text we should
  // include in the task instruction so the agent sees the immediate
  // request, not just a stale prefix.
  const trailingUserText: string[] = [];
  for (const m of mainMessages.slice(lastAssistantIdx + 1)) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      trailingUserText.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
          trailingUserText.push(String(block.text));
        }
      }
    }
  }

  const taskBlock = INHERIT_TASK_PREAMBLE + task
    + (trailingUserText.length > 0
      ? `\n\nUser's most recent message(s) for context:\n${trailingUserText.join('\n---\n')}`
      : '');

  return [...prefix, { role: 'user', content: taskBlock }];
}

export async function runEditNoteAgent(opts: EditAgentRunOptions): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = opts.contextMode === 'inherit'
    ? (opts.mainSystemPrompt ?? FRESH_SYS_PROMPT)
    : FRESH_SYS_PROMPT;

  const taskWithTarget = `Edit note ${opts.noteId} in nook ${opts.nookId}. Task: ${opts.task}`;

  const messages: Anthropic.MessageParam[] = opts.contextMode === 'inherit' && opts.mainMessages
    ? buildInheritMessages(opts.mainMessages, taskWithTarget)
    : [{ role: 'user', content: taskWithTarget }];

  opts.onProgress?.('Starting edit...');

  for (let depth = 0; depth < MAX_EDIT_DEPTH; depth++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        tools: EDIT_AGENT_TOOLS,
        messages,
        system: systemPrompt,
      });
    } catch (err) {
      return `Edit agent error: ${err instanceof Error ? err.message : 'unknown error'}`;
    }

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
      return text === '' ? 'Edit agent finished but returned no summary.' : text;
    }

    if (response.stop_reason !== 'tool_use') {
      // Unexpected stop reason (max_tokens, etc) — surface what we have
      // so the main assistant can report sensibly.
      const partial = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
      return `Edit agent stopped (${response.stop_reason}). ${partial || '(no text)'}`;
    }

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolNames = toolBlocks.map(t => t.name);
    opts.onProgress?.(`Step ${depth + 1}: ${toolNames.join(', ')}`);

    // Execute with concurrency cap (matches main-loop policy).
    const resultBlocks: Anthropic.ToolResultBlockParam[] = await mapWithConcurrency(
      toolBlocks,
      3,
      async (t): Promise<Anthropic.ToolResultBlockParam> => {
        if (!ALLOWED_TOOLS.has(t.name)) {
          return {
            type: 'tool_result',
            tool_use_id: t.id,
            content: `Tool not allowed in edit agent: ${t.name}`,
            is_error: true,
          };
        }
        // Force-restrict to the approved note. The agent was pre-
        // approved for a single specific note; any tool call whose
        // `note_id` input points elsewhere is rejected at this layer
        // before it can reach the API. Tools that don't take a
        // note_id at all (list_type_attributes, ask_user) skip the
        // check naturally — `requestedNoteId` is undefined for them.
        const input = (t.input ?? {}) as Record<string, unknown>;
        const requestedNoteId =
          typeof input.note_id === 'string' && input.note_id.trim() !== ''
            ? input.note_id.trim()
            : undefined;
        if (requestedNoteId !== undefined && requestedNoteId !== opts.noteId) {
          return {
            type: 'tool_result',
            tool_use_id: t.id,
            content:
              `You were pre-approved to work on note ${opts.noteId} only. `
              + `Refusing to touch note ${requestedNoteId}. `
              + `If you need to work on a different note, stop and return a summary explaining what you found and what the user should approve separately.`,
            is_error: true,
          };
        }
        try {
          // Lock nook_id to the target nook too — defense in depth so
          // the agent can't accidentally cross nooks even on tools
          // that don't take note_id.
          const sanitizedInput: Record<string, unknown> = { ...input };
          sanitizedInput.nook_id = opts.nookId;
          const result = await executeTool(
            t.name,
            sanitizedInput,
            opts.apiBase,
            opts.cookie,
            opts.nookId,
            opts.memoryNookId,
          );
          return { type: 'tool_result', tool_use_id: t.id, content: result };
        } catch (err) {
          return {
            type: 'tool_result',
            tool_use_id: t.id,
            content: `Error: ${err instanceof Error ? err.message : 'unknown error'}`,
            is_error: true,
          };
        }
      },
    );

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: resultBlocks });
  }

  // Depth-limit fallback — ask the agent for its summary now.
  opts.onProgress?.('Compiling summary...');
  try {
    const finalResponse = await client.messages.create({
      model: opts.model,
      max_tokens: 1024,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            "You've reached the edit-agent depth limit. Stop using tools. Reply with a single plain-text 1-3 sentence summary of what you did so far (or why you couldn't complete the task).",
        },
      ],
      system: systemPrompt,
    });
    const text = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    return text === ''
      ? 'Edit agent reached depth limit without producing a summary.'
      : text;
  } catch {
    return 'Edit agent reached depth limit and failed to compile a summary.';
  }
}
