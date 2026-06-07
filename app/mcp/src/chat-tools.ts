import type Anthropic from '@anthropic-ai/sdk';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_note',
    description: 'Get a single note by ID. Always pass nook_id — use the nook ID from where you found this note (search results, instruction list, memory nook, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID where this note lives. Required for cross-nook access. Defaults to current nook if omitted.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'create_note',
    description: 'Create a new note in the current nook. You MUST always set type_id — call list_note_types first to pick the most appropriate type (or use the base type key "base" as fallback). You can pass the type key string (e.g. "base", "file") or UUID. Pass attributes as a JSON object keyed by attribute UUIDs.',
    input_schema: {
      type: 'object',
      properties: {
        title:      { type: 'string' },
        content:    { type: 'string', description: 'Note content in markdown. To link to another note use [[note:<full_uuid>]] with the complete UUID (never shorten) — the title is resolved automatically. To embed a file note as an image use ![Note Title](note:<full_uuid>).' },
        type_id:    { type: 'string', description: 'Note type ID or key (e.g. "base", "meeting"). Always set this — use "base" as fallback if unsure.' },
        attributes: { type: 'object', description: 'JSON attributes keyed by attribute UUID' },
      },
      required: ['title', 'type_id'],
    },
  },
  {
    name: 'update_note',
    description: 'Update an existing note. Only include fields you want to change — omitted fields keep their current values. You MUST pass expected_version (from reading the note) to detect concurrent edits. If the version has changed, the update will fail with a 409 conflict.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:          { type: 'string' },
        expected_version: { type: 'number', description: 'The version number from when you last read the note. Required to prevent overwriting concurrent edits.' },
        title:            { type: 'string', description: 'New title. Omit to keep existing title.' },
        content:          { type: 'string', description: 'Note content in markdown. To link to another note use [[note:<full_uuid>]] with the complete UUID (never shorten) — the title is resolved automatically. To embed a file note as an image use ![Note Title](note:<full_uuid>).' },
        type_id:          { type: 'string', description: 'Change the note type (triggers attribute archive/restore)' },
        attributes:       { type: 'object', description: 'JSON attributes keyed by attribute UUID. Null values delete keys.' },
      },
      required: ['note_id', 'expected_version'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note (only the creator or nook owner can delete)',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'list_note_types',
    description: 'List note types (taxonomy) defined in the current nook. Returns both the raw list and a formatted hierarchy tree so you can see parent/child relationships at a glance. Always call this before creating a new type.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_note_type',
    description: 'Create a new note type in the current nook\'s taxonomy. Always call list_note_types first so you can see the existing hierarchy and choose the right parent. Show the user a summary like "Creating type \'Employee\' under \'Person\'" before proceeding. The key must be a unique lowercase slug (e.g. "employee", "project-phase").',
    input_schema: {
      type: 'object',
      properties: {
        label:       { type: 'string', description: 'Display name, e.g. "Employee"' },
        key:         { type: 'string', description: 'Unique lowercase slug, e.g. "employee". Must be unique within the nook.' },
        description: { type: 'string', description: 'Optional description of what this type represents' },
        parent_id:   { type: 'string', description: 'UUID of the parent type. Omit for a root-level type.' },
      },
      required: ['label', 'key'],
    },
  },
  {
    name: 'update_note_type',
    description: 'Update the label or description of an existing note type. Use this to rename a type or improve its description. Does not change the key or parent — those are structural changes that should be done in settings.',
    input_schema: {
      type: 'object',
      properties: {
        type_id:     { type: 'string', description: 'UUID of the type to update' },
        label:       { type: 'string', description: 'New display name' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['type_id'],
    },
  },
  {
    name: 'list_type_attributes',
    description: 'List all attributes defined on a note type, including inherited attributes from ancestor types. Returns each attribute\'s id, name, kind, config (display options, select options, etc.), inherited flag, and overridden flag. Hidden inherited attributes are excluded. Use this to understand what structured data a type supports before creating or updating notes with attributes.',
    input_schema: {
      type: 'object',
      properties: {
        type_id: { type: 'string', description: 'The note type ID' },
      },
      required: ['type_id'],
    },
  },
  {
    name: 'get_note_history',
    description: 'Get the edit history of a note — who changed it, when, and at which version. Returns a list of history entries with version numbers, action (INSERT/UPDATE), user, and timestamp. Use this to understand how a note evolved over time, or to find a specific version to inspect. To link to a version: /nooks/{nookId}/notes/{noteId}/v/{version}. To link to a diff: /nooks/{nookId}/notes/{noteId}/compare/{fromVersion} (or /compare/{from}/{to}).',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID. Defaults to current nook if omitted.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_note_version',
    description: 'Get a specific historical version of a note by version number. Returns the full note snapshot (title, content, attributes) as it was at that version. Use after get_note_history to inspect a particular version. To link users to this version: /nooks/{nookId}/notes/{noteId}/v/{version}',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID. Defaults to current nook if omitted.' },
        version: { type: 'number', description: 'The version number to retrieve (from get_note_history)' },
      },
      required: ['note_id', 'version'],
    },
  },
  {
    name: 'compare_note_versions',
    description: 'Compare two versions of a note. Returns a unified diff of the content, plus metadata (title, type, attributes) for both versions. If "to_version" is omitted, compares against the current version. To link users to a diff view, use: /nooks/{nookId}/notes/{noteId}/compare/{fromVersion} or /nooks/{nookId}/notes/{noteId}/compare/{fromVersion}/{toVersion}',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID. Defaults to current nook if omitted.' },
        from_version: { type: 'number', description: 'The older version number to compare from' },
        to_version: { type: 'number', description: 'The newer version number to compare to. Omit to compare against current.' },
      },
      required: ['note_id', 'from_version'],
    },
  },
  {
    name: 'get_note_summary',
    description: 'Get lightweight note metadata: title, type, attributes, and table of contents (headings) — without loading the full content. Use this to understand a note\'s structure before deciding which section to read. Much cheaper than get_note for long notes.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID. Defaults to current nook if omitted.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_note_section',
    description: 'Read a specific section of a note by character position. Use after get_note_summary or search_notes heading_matches to read just the relevant section instead of the full note. Returns the section content from the heading at the given position to the next heading of the same or higher level.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'The nook ID. Defaults to current nook if omitted.' },
        position: { type: 'number', description: 'Character offset of the section heading (from headings or heading_matches)' },
      },
      required: ['note_id', 'position'],
    },
  },
  {
    name: 'search_notes',
    description: 'Search notes by title, content, or attribute values. Use type_id to filter by note type, or "all" for all types. Use attribute_filters for structured queries like "rating >= 4" or "date between X and Y". When a search query is provided, results also include heading_matches — headings (h1-h6) extracted from notes that match the query, with note_id, note_title, level, text, and position (character offset for jump-to-section).',
    input_schema: {
      type: 'object',
      properties: {
        q:                  { type: 'string', description: 'Text search query (searches title and content). Leave empty to list all notes.' },
        type_id:            { type: 'string', description: 'Note type ID to filter by, or "all" for all types' },
        attribute_filters:  { type: 'string', description: 'JSON array of attribute filters. Each filter: {"attribute_id":"<uuid>","op":"<operator>","value":<value>}. Operators: eq, neq, gt, gte, lt, lte (number), date_gt/date_gte/date_lt/date_lte (date), contains/starts_with (text), is_null/is_not_null, in (select array), overlaps (date_range with {"from":"...","to":"..."}).' },
        search_mode:        { type: 'string', enum: ['and', 'or'], description: 'How to combine multiple search words. Default: "and".' },
        sort:               { type: 'string', enum: ['newest', 'oldest', 'updated_newest', 'updated_oldest'], description: 'Sort order. Default: newest.' },
        cursor:             { type: 'string', description: 'Pagination cursor from previous response' },
      },
      required: [],
    },
  },
  {
    name: 'start_new_chat',
    description: 'Propose starting a new chat with a pre-filled first message. The user will be asked to confirm. Use this when the conversation should move to a fresh context — e.g. topic switch, context window pressure, or wrapping up. The message should contain relevant context/summary for the new chat to pick up where this one leaves off.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The first user message for the new chat. Include relevant context, summary of decisions, or the new topic.' },
        reason: { type: 'string', description: 'Brief reason shown to the user for why a new chat is suggested.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'ask_user',
    description: 'Present the user with quick-reply buttons for simple choices. Use this when you need a yes/no confirmation, a choice between 2-4 options, or any simple decision. The user sees clickable buttons but can also type a free-form response instead. Always include your question in the preceding text — the buttons are just a convenience.',
    input_schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Button labels (2-5 short options, max 5). E.g. ["Yes", "No"] or ["Option A", "Option B", "Something else"]',
        },
        other_label: {
          type: 'string',
          description: 'Custom label for the free-form reply button. Defaults to "Other…" if omitted.',
        },
      },
      required: ['options'],
    },
  },
  {
    name: 'search_all_nooks',
    description: 'Search notes across ALL nooks the user has access to. Only use this when the user explicitly asks to search globally, or when a local search_notes returned no results and you want to ask the user if they\'d like to search more broadly. Prefer search_notes (local to current nook) first. Also returns heading_matches for headings matching the query.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Text search query (searches title and content across all accessible nooks)' },
        search_mode: { type: 'string', enum: ['and', 'or'], description: 'How to combine multiple search words. Default: "and".' },
      },
      required: ['q'],
    },
  },
  {
    name: 'open_note',
    description: 'Open a note in the user\'s editor. The user must confirm before this happens.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'ID of the note to open' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'explore_notes',
    description: 'Explore the note graph via BFS from a starting note. Returns all links found at every hop. Use depth 2–3 to discover indirect connections — intermediate nodes do not need to match any filter. Combine with q/node_type_ids to surface only relevant results while still traversing the full neighbourhood.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:       { type: 'string', description: 'The starting note ID' },
        direction:     { type: 'string', enum: ['out', 'in', 'both'], description: 'Link direction to follow' },
        depth:         { type: 'number', description: 'Traversal depth 1–5. Use 1 for direct links, 2–3 for broader neighbourhood, up to 5 for wide exploration.', minimum: 1, maximum: 5 },
        predicate_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only traverse links with these predicate IDs.',
        },
        node_type_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only surface links where source or target has one of these type IDs. Traversal still goes through all types.',
        },
        q: {
          type: 'string',
          description: 'Only surface links where at least one connected note (excluding start) matches this term in title or content. Multiple words are split and matched independently. Use double quotes for exact phrases. Traversal is unaffected.',
        },
        search_mode: {
          type: 'string',
          enum: ['and', 'or'],
          description: 'How to combine multiple search words in q. "and" (default): all words must match. "or": any word can match.',
        },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_note_mentions',
    description: 'Get text mention references for a note — notes that this note mentions (outgoing) and notes that mention this note (incoming). Different from structural links.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'list_link_predicates',
    description: 'List link types (predicates) available in the current nook. Each predicate has a forward_label (e.g. "relates to") and reverse_label. Use predicate_id when creating links. Empty source/target type rules mean any note type is allowed.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_note_link',
    description: 'Create a directed link between two notes using a predicate',
    input_schema: {
      type: 'object',
      properties: {
        source_note_id: { type: 'string' },
        target_note_id: { type: 'string' },
        predicate_id:   { type: 'string' },
        start_date:     { type: 'string', description: 'ISO date string' },
        end_date:       { type: 'string', description: 'ISO date string' },
      },
      required: ['source_note_id', 'target_note_id', 'predicate_id'],
    },
  },
  // ── Search agent (sub-agent with own context window) ──
  {
    name: 'search_agent',
    description: 'Delegate a research task to a search agent that runs in its own context window. The agent searches and reads notes in the current nook and user memories — the user will be asked to approve before it runs. It returns ranked results with relevant excerpts, keeping this conversation\'s context clean. Use this instead of searching manually when the query may require reading multiple notes or complex filtering. For simple single-note lookups, prefer search_notes/get_note directly. Always tell the user what you\'re about to search for and that the agent will search their notes.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A clear description of what to research. Be specific about what information you need and how results should be organized.',
        },
      },
      required: ['task'],
    },
  },
  // ── Image generation (creates a file note in ai-memory by default) ──
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt and store it as a file note in the user\'s AI memory nook (default) or a specific nook. Costs real money per call — the user is asked to approve. Returns the new note\'s id, title, and the model\'s revised_prompt so you can reference it in chat with [[note:id]]. Use this when the user explicitly asks for an image; do not generate proactively. To put the image in a specific nook instead of ai-memory, pass nook_id with that nook\'s UUID.',
    input_schema: {
      type: 'object',
      properties: {
        prompt:      { type: 'string', description: 'What to generate. Be specific — the provider rewrites short prompts and you\'ll get a revised_prompt back showing what it actually drew.' },
        nook_id:     { type: 'string', description: 'Target nook UUID. Omit to drop the image in ai-memory (the default and recommended behaviour).' },
        size:        { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'], description: 'Output dimensions. Default 1024x1024.' },
        transparent: { type: 'boolean', description: 'Generate with a transparent background (PNG with alpha). Default false.' },
      },
      required: ['prompt'],
    },
  },
  // ── User memory nook tools (cross-nook, auto-approved) ──
  {
    name: 'memory_search',
    description: 'Search the user\'s personal AI memory nook. Use this to recall cross-nook information about the user (preferences, facts, patterns). Auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query (optional — omit to list all memories)' },
      },
    },
  },
  {
    name: 'memory_get',
    description: 'Read a specific note from the user\'s AI memory nook. Auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'memory_create',
    description: 'Create a note in the user\'s AI memory nook. Use for cross-nook user knowledge. Auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string' },
        content: { type: 'string', description: 'Markdown content' },
      },
      required: ['title'],
    },
  },
  {
    name: 'memory_update',
    description: 'Update a note in the user\'s AI memory nook. Auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        title:   { type: 'string' },
        content: { type: 'string' },
      },
      required: ['note_id'],
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  apiBaseUrl: string,
  cookie: string,
  nookId: string,
  memoryNookId?: string,
): Promise<string> {
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-Nook-Actor': 'ai',
  };

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status} ${method} ${path}: ${text.slice(0, 800)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      // The API returned 2xx but non-JSON — typically PHP warning HTML
      // leaking ahead of the JSON body. Include the first chunk of the
      // raw response in the error so the upstream caller (and the AI
      // surfacing it) can see what actually came back.
      const snippet = text.slice(0, 800).replace(/\s+/g, ' ').trim();
      throw new Error(
        `API ${method} ${path} returned non-JSON (status ${res.status}, content-type ${res.headers.get('content-type') ?? 'unknown'}): ${snippet}`,
      );
    }
  };
  const noteId = String(input.note_id ?? '');

  switch (name) {
    case 'get_note': {
      const getNookId = typeof input.nook_id === 'string' && input.nook_id.trim() !== '' ? input.nook_id.trim() : nookId;
      return JSON.stringify(await api('GET', `/api/nooks/${getNookId}/notes/${noteId}`));
    }

    case 'create_note': {
      const { note_id: _, ...rawBody } = input;
      let body: Record<string, unknown> = rawBody;
      // If type_id is a key string (not UUID), resolve to actual UUID
      if (typeof body.type_id === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(body.type_id)) {
        try {
          const typesData = await api('GET', `/api/nooks/${nookId}/note-types`) as { types?: Array<{ id: string; key: string }> };
          const key = body.type_id as string;
          // Try exact key match, then fall back to 'base' type
          const match = typesData?.types?.find(t => t.key === key)
            ?? typesData?.types?.find(t => t.key === 'base');
          if (match) {
            body = { ...body, type_id: match.id };
          } else {
            // No types at all — strip type_id to avoid sending invalid string
            const { type_id: _, ...rest } = body;
            body = rest;
          }
        } catch { /* best-effort — strip non-UUID type_id to avoid API error */
          const { type_id: _, ...rest } = body;
          body = rest;
        }
      }
      return JSON.stringify(await api('POST', `/api/nooks/${nookId}/notes`, body));
    }

    case 'update_note': {
      const { note_id: _, ...body } = input;
      return JSON.stringify(await api('PUT', `/api/nooks/${nookId}/notes/${noteId}`, body));
    }

    case 'delete_note':
      await api('DELETE', `/api/nooks/${nookId}/notes/${noteId}`);
      return JSON.stringify({ success: true });

    case 'list_note_types': {
      const data = await api('GET', `/api/nooks/${nookId}/note-types`) as { types?: Array<{ id: string; key: string; label: string; description: string; parent_id: string }> };
      const types = data?.types ?? [];
      const buildTree = (parentId: string, depth: number): string[] =>
        types
          .filter(t => (t.parent_id ?? '') === parentId)
          .flatMap(t => [
            `${'  '.repeat(depth)}- ${t.label} (id: ${t.id}, key: ${t.key}${t.description ? `, desc: "${t.description}"` : ''})`,
            ...buildTree(t.id, depth + 1),
          ]);
      const hierarchy = buildTree('', 0).join('\n') || '(no types defined)';
      return JSON.stringify({ types, hierarchy });
    }

    case 'list_type_attributes': {
      const typeId = String(input.type_id ?? '');
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/note-types/${typeId}/attributes`));
    }

    case 'create_note_type': {
      const body: Record<string, unknown> = {
        key:   String(input.key ?? ''),
        label: String(input.label ?? ''),
      };
      if (input.description) body.description = String(input.description);
      if (input.parent_id)   body.parent_id   = String(input.parent_id);
      return JSON.stringify(await api('POST', `/api/nooks/${nookId}/note-types`, body));
    }

    case 'update_note_type': {
      const typeId = String(input.type_id ?? '');
      // Fetch current type to get required fields (key, label)
      const typesData = await api('GET', `/api/nooks/${nookId}/note-types`) as { types?: Array<Record<string, unknown>> };
      const current = typesData?.types?.find(t => t.id === typeId);
      const body: Record<string, unknown> = {
        key: current?.key ?? '',
        label: current?.label ?? '',
        description: current?.description ?? '',
        parent_id: current?.parent_id ?? '',
      };
      if (input.label !== undefined)       body.label       = String(input.label);
      if (input.description !== undefined) body.description = String(input.description);
      return JSON.stringify(await api('PUT', `/api/nooks/${nookId}/note-types/${typeId}`, body));
    }

    case 'get_note_mentions':
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/notes/${noteId}/mentions`));

    case 'list_link_predicates':
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/link-predicates`));

    case 'get_note_history': {
      const targetNook = String(input.nook_id || nookId);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/history`));
    }

    case 'get_note_version': {
      const targetNook = String(input.nook_id || nookId);
      const ver = Number(input.version ?? 1);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/history/v${ver}`));
    }

    case 'compare_note_versions': {
      const targetNook = String(input.nook_id || nookId);
      const params = new URLSearchParams();
      params.set('from', String(input.from_version ?? 1));
      if (input.to_version) params.set('to', String(input.to_version));
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/diff?${params}`));
    }

    case 'get_note_summary': {
      const targetNook = String(input.nook_id || nookId);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/summary`));
    }

    case 'get_note_section': {
      const targetNook = String(input.nook_id || nookId);
      const pos = Number(input.position ?? 0);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}?section_at=${pos}`));
    }

    case 'search_notes': {
      const typeId = String(input.type_id ?? 'all');
      const params = new URLSearchParams();
      if (input.q) params.set('q', String(input.q));
      if (input.attribute_filters) params.set('attribute_filters', String(input.attribute_filters));
      if (input.search_mode) params.set('search_mode', String(input.search_mode));
      if (input.sort) params.set('sort', String(input.sort));
      if (input.cursor) params.set('cursor', String(input.cursor));
      const qs = params.toString() ? `?${params}` : '';
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/note-types/${typeId}/notes${qs}`));
    }

    case 'start_new_chat': {
      // This is handled by the frontend — just return confirmation
      return JSON.stringify({ success: true, message: String(input.message ?? '') });
    }

    case 'search_all_nooks': {
      const params = new URLSearchParams();
      params.set('q', String(input.q ?? ''));
      params.set('limit', '20');
      if (input.search_mode) params.set('search_mode', String(input.search_mode));
      return JSON.stringify(await api('GET', `/api/search?${params}`));
    }

    case 'open_note':
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/notes/${noteId}`));

    case 'explore_notes': {
      const params = new URLSearchParams({
        direction: String(input.direction ?? 'both'),
        depth:     String(Math.min(5, Math.max(1, Number(input.depth ?? 1)))),
      });
      if (Array.isArray(input.predicate_ids) && input.predicate_ids.length > 0) {
        params.set('predicate_ids', (input.predicate_ids as string[]).join(','));
      }
      if (Array.isArray(input.node_type_ids) && input.node_type_ids.length > 0) {
        params.set('node_type_ids', (input.node_type_ids as string[]).join(','));
      }
      if (input.q) params.set('q', String(input.q));
      if (input.search_mode) params.set('search_mode', String(input.search_mode));
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/notes/${noteId}/links?${params}`));
    }

    case 'create_note_link': {
      const sourceNoteId = String(input.source_note_id ?? '');
      return JSON.stringify(
        await api('POST', `/api/nooks/${nookId}/notes/${sourceNoteId}/links`, {
          target_note_id: input.target_note_id,
          predicate_id:   input.predicate_id,
          start_date:     input.start_date,
          end_date:       input.end_date,
        }),
      );
    }

    // ── Image generation ──
    case 'generate_image': {
      // Sentinel "ai-memory" is resolved server-side; pass it through
      // whenever the caller doesn't specify a nook so we don't have
      // to round-trip GET /nooks/ai-memory from here.
      const target = typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim()
        : 'ai-memory';
      const body: Record<string, unknown> = { prompt: String(input.prompt ?? '') };
      if (input.size)         body.size = String(input.size);
      if (input.transparent)  body.transparent = true;
      return JSON.stringify(await api('POST', `/api/nooks/${target}/ai-images`, body));
    }

    // ── User memory nook tools ──
    case 'memory_search': {
      if (!memoryNookId) throw new Error('AI memory nook not available');
      const params = new URLSearchParams();
      if (input.q) params.set('q', String(input.q));
      const qs = params.toString() ? `?${params}` : '';
      return JSON.stringify(await api('GET', `/api/nooks/${memoryNookId}/note-types/all/notes${qs}`));
    }

    case 'memory_get': {
      if (!memoryNookId) throw new Error('AI memory nook not available');
      const mid = String(input.note_id ?? '');
      return JSON.stringify(await api('GET', `/api/nooks/${memoryNookId}/notes/${mid}`));
    }

    case 'memory_create': {
      if (!memoryNookId) throw new Error('AI memory nook not available');
      return JSON.stringify(await api('POST', `/api/nooks/${memoryNookId}/notes`, {
        title: input.title,
        content: input.content ?? '',
      }));
    }

    case 'memory_update': {
      if (!memoryNookId) throw new Error('AI memory nook not available');
      const uid = String(input.note_id ?? '');
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body.title = input.title;
      if (input.content !== undefined) body.content = input.content;
      return JSON.stringify(await api('PUT', `/api/nooks/${memoryNookId}/notes/${uid}`, body));
    }

    case 'ask_user': {
      const options = Array.isArray(input.options) ? input.options.map(String) : [];
      return JSON.stringify({ presented: true, options, note: 'Buttons shown to user. Wait for their next message.' });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
