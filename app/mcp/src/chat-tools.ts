import type Anthropic from '@anthropic-ai/sdk';
import {
  getOptionalToolHandler,
  optionalToolDefinitions,
} from './tools/registry.js';

// Always-on core tools (notes, memory, etc.) live in this array. Tools
// that should be conditionally registered based on env (weather,
// wikipedia, image generation) live in app/mcp/src/tools/<name>.ts and
// self-gate via their module's `enabled()` getter; the registry merges
// enabled ones into TOOLS at module load time.
const CORE_TOOLS: Anthropic.Tool[] = [
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
        content:          { type: 'string', description: 'New note content in markdown. Omit to keep existing content unchanged (do NOT pass an empty string just to "leave it alone" — that clears the note). To link to another note use [[note:<full_uuid>]] with the complete UUID (never shorten). To embed a file note as an image use ![Note Title](note:<full_uuid>).' },
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
    description: 'Create a new note type in the current nook\'s taxonomy. Always call list_note_types first so you can see the existing hierarchy and choose the right parent. Show the user a summary like "Creating type \'Employee\' under \'Person\'" before proceeding. The key must be a unique lowercase slug (e.g. "employee", "project-phase"). Schema mutations (create/update/delete on note types and their attributes) require the user to be the nook owner — this will 403 in nooks the user only collaborates on (including ai-memory, which is system-owned). Don\'t suggest schema changes in those nooks.',
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
    description: 'Update the label or description of an existing note type. Use this to rename a type or improve its description. Does not change the key or parent — those are structural changes that should be done in settings. Owner-only: will 403 in shared nooks where the user isn\'t the nook owner.',
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
    description: 'Search notes by title, content, or attribute values. Returns a LEAN list — each result is {id, nook_id, title, type_id, version, timestamps, mention/link counts, content_chars}. `version` rides along so you can pass it straight to edit_note/update_note without a separate get_note round-trip.\n\nSearch is cheap and lean. When the user\'s ask can be approached from multiple angles (synonyms, related concepts, sibling categories, different attribute_filters), issue SEVERAL search_notes calls in PARALLEL in the same turn — one per angle. Then dedupe results by id and decide which ones are worth a deep read.\n\n**Don\'t give up after one miss.** A query returning zero results rarely means "doesn\'t exist" — it usually means your wording didn\'t match what the user wrote. Before concluding the note isn\'t there, try at least 2-3 alternative phrasings: synonyms ("car" / "vehicle" / "automobile"), parent/child concepts ("Bordeaux" / "wine" / "drink"), partial words, related entities, or just a different keyword from the same idea. The user almost always thinks their note exists when they ask for it.\n\n**Reading decisions:** `content_chars` tells you the note size — small notes (<2000 chars) are cheap to get_note in full; big ones (>10000) burn context, so consider read_note_lines for a peek first. To read a note\'s full content/attributes, follow up with get_note(id) — parallelize across multiple candidates (they\'re independent).\n\nUse type_id to filter by note type. Use attribute_filters for structured queries like "rating >= 4" or "date between X and Y" — those filter server-side without you needing to read the values. When a search query is provided, results also include heading_matches — headings (h1-h6) extracted from notes that match the query, with note_id, note_title, level, text, and position (character offset for jump-to-section).',
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
    description: 'Search notes across ALL nooks the user has access to. Returns {id, nook_id, title, type_id, version, ...} per result — `version` is inline so you can edit_note without a separate get_note first. Use this when the user explicitly asks to search globally, OR when local search_notes returned nothing useful after 2-3 alternate phrasings — the note might live in a different nook than the current one. Prefer search_notes (local to current nook) first. Also returns heading_matches for headings matching the query and per-result content_chars to budget reads.\n\nLike search_notes, this is cheap and lean — fan out several search_all_nooks calls in parallel with different angles (synonyms, related terms) in the same turn and dedupe by id before deciding which notes to deep-read via get_note. Same tenacity rule: zero results from one query isn\'t proof of absence — try other angles before giving up.',
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
  {
    name: 'delete_note_link',
    description: 'Delete a directed link between two notes. First call explore_notes on the source note (direction="out") to find the link_id you need — links list as { id, target_note_id, predicate_id, ... }. Requires user approval.',
    input_schema: {
      type: 'object',
      properties: {
        source_note_id: { type: 'string', description: 'The note the link originates from.' },
        link_id:        { type: 'string', description: 'The link UUID (from explore_notes results).' },
      },
      required: ['source_note_id', 'link_id'],
    },
  },
  {
    name: 'edit_note',
    description: 'Make one or more surgical, search-and-replace edits to an existing note\'s content WITHOUT having to send the whole note back. Each edit substitutes old_string → new_string. By default each edit must match exactly once in the content (uniqueness safety net — non-unique matches are almost always ambiguous mistakes); pass replace_all=true on an individual edit to substitute every occurrence.\n\nTwo input shapes are accepted (pick whichever is more convenient — no need to wrap a single edit in an array):\n\n**Single edit** (no `edits` key needed):\n```\n{ "note_id": "...", "expected_version": 5, "old_string": "foo", "new_string": "bar" }\n```\n\n**Multiple edits** (batched atomically, edit N+1 sees the result of edit N):\n```\n{ "note_id": "...", "expected_version": 5,\n  "edits": [\n    { "old_string": "foo",  "new_string": "bar" },\n    { "old_string": "baz",  "new_string": "qux", "replace_all": true }\n  ]\n}\n```\n\nThe aliases `find` / `replace` are also accepted in place of `old_string` / `new_string` at either level.\n\nAtomic: if any edit fails (not found, not unique, or version conflict) the WHOLE call rolls back — nothing changes. One user approval covers the whole batch, and the diff preview stacks them so the user sees the full set before committing.\n\nWhen to use: tweaking a section, fixing typos (a single call can fix several across the note), swapping values, adding/removing paragraphs, batch renames. Cheaper and safer than update_note for partial changes — preserves everything else byte-for-byte.\n\nWhen NOT to use: large rewrites, structural reorganization, type/attribute changes — use update_note for those. To delete text, pass an empty new_string. The note must be read first (so you know the byte-for-byte text) and you MUST pass expected_version from that read so concurrent edits are detected (409 conflict). For multi-edit batches, plan the edits so a later one\'s old_string still matches after earlier ones have applied (or use unique enough context strings that order doesn\'t matter).',
    input_schema: {
      type: 'object',
      properties: {
        note_id:          { type: 'string' },
        nook_id:          { type: 'string', description: 'Nook the note lives in. Defaults to current nook if omitted.' },
        expected_version: { type: 'number', description: 'Version number from when you last read the note. Required.' },
        // Batched form. Omit for a single edit and put old_string/new_string at the top level.
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              old_string:  { type: 'string', description: 'Exact existing text to replace (alias: `find`). Must match byte-for-byte (whitespace + casing).' },
              new_string:  { type: 'string', description: 'Replacement text (alias: `replace`). Pass "" to delete the match.' },
              replace_all: { type: 'boolean', description: 'If true, substitute every occurrence (against the running content). Defaults to false (must match exactly once or the entire call fails).' },
            },
          },
        },
        // Single-edit shortcut. Use these top-level fields when there\'s just one edit — no array wrapping needed.
        old_string:  { type: 'string', description: 'Single-edit shortcut: text to replace (alias: `find`).' },
        new_string:  { type: 'string', description: 'Single-edit shortcut: replacement text (alias: `replace`).' },
        replace_all: { type: 'boolean', description: 'Single-edit shortcut: apply to every occurrence. Defaults to false.' },
      },
      required: ['note_id', 'expected_version'],
    },
  },
  {
    name: 'read_note_lines',
    description: 'Read a slice of a note\'s content by line number — useful for large notes where get_note would burn context. Returns the requested lines with 1-indexed line numbers prefixed, plus the note\'s current version (needed for edit_note). Omit start_line/end_line to read the whole file with line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:    { type: 'string' },
        nook_id:    { type: 'string', description: 'Nook the note lives in. Defaults to current nook if omitted.' },
        start_line: { type: 'number', description: '1-indexed inclusive. Defaults to 1.' },
        end_line:   { type: 'number', description: '1-indexed inclusive. Defaults to end of file.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_note_toc',
    description: 'Get the table of contents for a note — title, total content_chars, and each heading\'s {level, text, position, position_end, chars}. Auto-approved, very cheap (no body, no attributes).\n\nUse this for big notes (content_chars >5000) before deciding to get_note the full body. The per-heading `chars` field tells you each section\'s size at a glance, so you can pick which sections to read in full and which to skip. To read one section: feed its `position` directly to get_note_section(note_id, position) — that returns the content from the heading to the next heading of equal or higher level (exactly the span `chars` indicates). To read a CONTIGUOUS RANGE of sections (e.g. chapters 3-5), use get_note_part(from=section3.position, to=section5.position_end) — one round-trip instead of three. Returns an empty headings array if the note has no markdown headings — in that case fall back to read_note_lines or get_note based on content_chars.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'Nook the note lives in. Defaults to current nook if omitted.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_note_part',
    description: 'Read a half-open character range [from, to) of a note\'s content. Auto-approved. Pairs with get_note_toc: pick the first section\'s `position` as `from` and the last section\'s `position_end` as `to` to read N adjacent sections in one shot — vs. N separate get_note_section calls. `to` is exclusive so you can pass a TOC `position_end` directly without overshooting into the next heading. Bounds clamp to [0, content_chars]; the response includes the actual `from`/`to` used and a `truncated` flag if requested range exceeded content.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        nook_id: { type: 'string', description: 'Nook the note lives in. Defaults to current nook if omitted.' },
        from:    { type: 'number', description: 'Character offset (0-indexed, inclusive). Use a heading\'s `position` from get_note_toc.' },
        to:      { type: 'number', description: 'Character offset (exclusive). Use a heading\'s `position_end` from get_note_toc.' },
      },
      required: ['note_id', 'from', 'to'],
    },
  },
  {
    name: 'search_in_note',
    description: 'Find every occurrence of a string within ONE note\'s content. Returns the character position + a snippet of surrounding context for each match. Auto-approved.\n\nUse for big notes when you want to jump straight to relevant chunks — e.g. "find every mention of X in this 50KB DND session log" → get the positions → get_note_part(from, to) on the chunk you actually want. Cheaper than get_note + scanning client-side because the server returns only matches + context, not the whole note. Case-insensitive by default. Substring match, not regex — pass exact characters.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:        { type: 'string' },
        nook_id:        { type: 'string', description: 'Nook the note lives in. Defaults to current nook if omitted.' },
        q:              { type: 'string', description: 'Substring to find. Must be non-empty.' },
        context_chars:  { type: 'number', description: 'How many characters of surrounding context to return per match (each side). Defaults to 60. Max 500.' },
        case_sensitive: { type: 'boolean', description: 'Default false. Set true for exact-case matching.' },
      },
      required: ['note_id', 'q'],
    },
  },
  // ── Edit agent (sub-agent scoped to one note) ──
  {
    name: 'edit_note_agent',
    description:
      "Delegate a focused editing task on ONE specific note to a sub-agent. The sub-agent runs the read+edit loop in its own context window — so the note's full content doesn't pollute this conversation's context — and returns only a brief summary of what it did.\n\nUse this when:\n• The note is large (content_chars > 5000) and the edit is non-trivial — reading the body into THIS conversation would burn context you'll still need afterwards.\n• The task involves multiple coordinated edits (\"reorganize the dosage section + update the schedule + add a note about side effects\") — the agent can plan + execute without you tracking each surgical change.\n• The user might keep talking about other things after this edit and you don't want the note body sitting in your context the whole time.\n\nDo NOT use for:\n• Tiny edits where you already know the exact old_string/new_string — just call edit_note directly (faster, one round-trip).\n• Anything that touches more than one note — the agent is pre-approved for exactly ONE note id and will refuse calls to others. For multi-note coordination, do it in this conversation.\n\nSecurity model: the user pre-approves ONE specific note for the agent to work on (you must tell the user clearly which note + what you're delegating before calling this — they'll see an approval card). The agent CANNOT touch any other note: tool calls with mismatched note_id are rejected at the agent's executor before reaching the API. The agent has read tools (get_note, get_note_toc, get_note_part, etc.), edit tools (edit_note, update_note), and ask_user (for genuine ambiguity).\n\nContext modes:\n• context=\"inherit\" (default) — the agent inherits THIS conversation as cached prefix, so it knows the backstory. Best when the user gave loose / context-dependent instructions across several turns.\n• context=\"fresh\" — the agent starts with a minimal system prompt and just the task. Best when the task is fully self-contained (\"rename X to Y\") and you don't need to pay for repeating long context. Slightly cheaper for big main conversations.\n\nReturns a 1-3 sentence plain-text summary describing what the agent did. Relay that summary to the user — don't re-summarize or pretend you did the edit yourself.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: 'The note the agent is pre-approved to work on. The agent is physically restricted to this note id; cross-note tool calls inside the agent fail.',
        },
        task: {
          type: 'string',
          description: 'Natural-language description of what to do on the note. Be specific about the change — the agent will read the note as needed but it only knows what you tell it about the goal.',
        },
        nook_id: {
          type: 'string',
          description: 'Nook the note lives in. Defaults to the current nook.',
        },
        context: {
          type: 'string',
          enum: ['inherit', 'fresh'],
          description: 'Whether the agent inherits this conversation as its prefix (default) or starts cold. See main tool description.',
        },
      },
      required: ['note_id', 'task'],
    },
  },
  // ── Search agent (sub-agent with own context window) ──
  {
    name: 'search_agent',
    description: 'Delegate a research task to a search agent that runs in its own context window. The agent searches and reads notes in the current nook and user memories — the user will be asked to approve before it runs. It returns ranked results with relevant excerpts, keeping this conversation\'s context clean.\n\n**When to reach for this (don\'t under-use it):**\n• The question spans more than 2-3 notes (e.g. "summarise everything I know about X", "find patterns across my meeting notes").\n• Initial search_notes attempts with 2-3 different phrasings returned nothing useful and you\'re tempted to give up — let the agent try harder in its own context.\n• The topic is fuzzy or exploratory ("what have I been working on lately", "find any references to Y") rather than a specific lookup.\n• You\'d otherwise need to get_note on 4+ candidates to triage them — the agent does that triage without polluting this conversation.\n\nFor simple single-note lookups or when you already know the exact title/id, prefer search_notes/get_note directly. Always tell the user what you\'re about to search for and that the agent will search their notes.',
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
  // ── User memory nook tools (cross-nook, auto-approved) ──
  {
    name: 'memory_search',
    description: 'Search the user\'s personal AI memory nook. Use this to recall cross-nook information about the user (preferences, facts, patterns). Returns LEAN results (id + nook_id + title + type_id + version). `version` is inline so memory_update can proceed without a separate memory_get round-trip when you already know the target text.\n\nMemory recall is cheap and auto-approved — issue several memory_search calls in PARALLEL with different keywords/angles when the topic is broad (e.g. for a meeting-prep task, you might search "meeting", "agenda", the project name, and the attendees in parallel). Dedupe by id, then memory_get(id) — also in parallel — for the ones you actually need to read.',
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
  // ── Live editor tools (frontend-executed) ──
  // These four are dispatched back to the user\'s browser and return the
  // live in-editor state, NOT the on-disk version. Only meaningful when
  // the system prompt shows editor_state.is_open === true. Auto-approved
  // conceptually — the frontend answers silently — but MCP routes them
  // via the awaiting-approval SSE path (see FRONTEND_TOOLS in chat.ts).
  {
    name: 'get_current_editor',
    description: 'Read the LIVE content of the note the user currently has open in edit mode (in-browser buffer, may include unsaved keystrokes). Returns {is_open, note_id, nook_id, title, version, content}. Prefer this over get_note when editor_state.is_open is true and you want the freshest view of what the user is working on. Returns is_open=false if no editor is open — do NOT call this speculatively when no editor is open.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_current_editor_toc',
    description: 'Get the table of contents (headings) of the LIVE editor content. Same shape as get_note_toc but reads the in-browser buffer instead of disk. Cheap navigation for big open notes — pair with get_current_editor_part to read specific sections without pulling the whole content.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_current_editor_part',
    description: 'Read a half-open character range [from, to) of the LIVE editor content. Same shape as get_note_part but reads the in-browser buffer. Use with get_current_editor_toc to jump to specific sections in a big open note without pulling the whole thing.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Character offset (0-indexed, inclusive).' },
        to:   { type: 'number', description: 'Character offset (exclusive).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'edit_current_editor',
    description: 'Make a surgical find-and-replace edit against the LIVE editor buffer (not disk). Same semantics as edit_note but applies to the in-browser content: the user sees the change instantly in their editor. Returns {applied: true, new_version} on success, or {applied: false, error: "not_found" | "ambiguous"} if the exact string is not found once. On failure you MUST re-read via get_current_editor before retrying — the user may have typed since your last read.\n\nUse this INSTEAD of edit_note when editor_state.is_open === true and the target note_id matches editor_state.note_id — direct disk edits would race with the user\'s typing. For any other note, use edit_note as usual.\n\nData integrity: the exact-string match is the safety net (like edit_note). If the string is still uniquely present after the user\'s keystrokes, applying the edit is safe. If uniqueness fails, the call errors and you retry.',
    input_schema: {
      type: 'object',
      properties: {
        find:    { type: 'string', description: 'Exact existing text to replace. Must match byte-for-byte (whitespace + casing) and appear exactly once.' },
        replace: { type: 'string', description: 'Replacement text. Pass "" to delete.' },
      },
      required: ['find', 'replace'],
    },
  },
  // ── Browser-API bridges (frontend-executed) ──
  // These reach into the user\'s browser via the same round-trip flow
  // as the editor tools. Each one is auto-answered by the frontend
  // (no approval card) but the underlying API may prompt the OS/
  // browser for permission (geolocation, clipboard). Use sparingly
  // and only when the answer genuinely needs the user\'s live device
  // context — cheap questions like "where are you?" or "what\'s on
  // your clipboard?" are what these exist for.
  {
    name: 'get_current_location',
    description: 'Read the user\'s current geolocation (lat/lng/accuracy) via navigator.geolocation. The browser will prompt for permission the first time. Returns {lat, lng, accuracy_m, timestamp, ...} or {error, code} where code is 1=denied, 2=unavailable, 3=timeout.\n\nUse when the user asks for location-dependent info (weather here, nearby X, "what\'s my address") — don\'t call speculatively. Coarse accuracy is fine for most queries; set high_accuracy=true only when the user needs GPS-level precision (waypoints, hiking).',
    input_schema: {
      type: 'object',
      properties: {
        high_accuracy: { type: 'boolean', description: 'Ask for the highest-precision fix (GPS). Uses more battery. Defaults to false.' },
        timeout_ms:    { type: 'number',  description: 'Give up after this many ms. Defaults to 15000, clamped to [1000, 60000].' },
      },
    },
  },
  {
    name: 'get_current_selection',
    description: 'Read the text the user currently has selected in the browser (window.getSelection()). Returns {text, length, in_editable_field}. `in_editable_field` distinguishes text the user is authoring (input/textarea/contenteditable) from text they\'re reading. No permission needed; instant.\n\nUse when the user says "this", "what I selected", "explain this", or references selected text without pasting it in.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_clipboard',
    description: 'Read plain text from the system clipboard via navigator.clipboard.readText(). The browser will prompt for permission the first time (or the call may fail silently in some browsers if the page isn\'t focused). Returns {text, length} or {error}.\n\nUse when the user says "what\'s on my clipboard", "look at what I copied", or pastes an ambiguous reference. Do NOT call speculatively — clipboard content is sensitive.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_client_info',
    description: 'Read the user\'s browser + device context: user_agent, language, languages, timezone, viewport {width, height, device_pixel_ratio}, online, prefers_dark. Instant, no permission. Useful for localising times (timezone), picking mobile vs desktop responses (viewport), or answering "what browser am I on".',
    input_schema: { type: 'object', properties: {} },
  },
];

// Tools the LLM actually sees: core tools + whichever optional modules
// reported enabled() at module load. Disabled optional tools contribute
// zero bytes here — they're not in the system prompt at all.
export const TOOLS: Anthropic.Tool[] = [...CORE_TOOLS, ...optionalToolDefinitions];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  apiBaseUrl: string,
  cookie: string,
  nookId: string,
  memoryNookId?: string,
): Promise<string> {
  // Dispatch to a registered optional-module handler first; falls
  // through to the core switch when not found. We pass the same
  // context bundle every optional handler expects.
  const optional = getOptionalToolHandler(name);
  if (optional) {
    return optional(input, { apiBaseUrl, cookie, nookId, memoryNookId });
  }

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

    case 'get_note_toc': {
      const targetNook = String(input.nook_id || nookId);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/toc`));
    }

    case 'get_note_part': {
      const targetNook = String(input.nook_id || nookId);
      const from = Math.max(0, Math.floor(Number(input.from ?? 0)));
      const to = Math.max(from, Math.floor(Number(input.to ?? from)));
      const params = new URLSearchParams({ from: String(from), to: String(to) });
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/part?${params}`));
    }

    case 'search_in_note': {
      const targetNook = String(input.nook_id || nookId);
      const q = String(input.q ?? '').trim();
      if (q === '') throw new Error('search_in_note requires a non-empty q');
      const params = new URLSearchParams({ q });
      if (input.context_chars !== undefined) {
        params.set('context_chars', String(Math.max(0, Math.min(500, Math.floor(Number(input.context_chars))))));
      }
      if (input.case_sensitive === true) params.set('case_sensitive', '1');
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}/search?${params}`));
    }

    case 'get_note_section': {
      const targetNook = String(input.nook_id || nookId);
      const pos = Number(input.position ?? 0);
      return JSON.stringify(await api('GET', `/api/nooks/${targetNook}/notes/${noteId}?section_at=${pos}`));
    }

    case 'search_notes': {
      const typeId = String(input.type_id ?? '');
      const params = new URLSearchParams();
      // Lean by default — id/title/type_id + counts. The AI inspects
      // titles to pick which notes are worth a follow-up get_note
      // call (which it can parallelize across the candidates it
      // cares about). attribute_filters still works because that's a
      // server-side WHERE — the AI doesn't need to read the values
      // to filter by them.
      if (typeId !== '' && typeId !== 'all') {
        params.set('type_id', typeId);
        params.set('include_subtypes', '1');
      }
      if (input.q) params.set('q', String(input.q));
      if (input.attribute_filters) params.set('attribute_filters', String(input.attribute_filters));
      if (input.search_mode) params.set('search_mode', String(input.search_mode));
      if (input.sort) params.set('sort', String(input.sort));
      if (input.cursor) params.set('cursor', String(input.cursor));
      return JSON.stringify(await api('GET', `/api/nooks/${nookId}/notes?${params.toString()}`));
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

    case 'delete_note_link': {
      const sourceNoteId = String(input.source_note_id ?? '');
      const linkId = String(input.link_id ?? '');
      await api('DELETE', `/api/nooks/${nookId}/notes/${sourceNoteId}/links/${linkId}`);
      return JSON.stringify({ success: true });
    }

    case 'edit_note': {
      const editNookId = typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim() : nookId;
      // The schema requires an `edits` array — but be tolerant of an older
      // shape (single old_string/new_string at the top level) so a model
      // that hasn't reloaded the new tool doc doesn't 400 the call.
      let edits: unknown = input.edits;
      if (!Array.isArray(edits) && typeof input.old_string === 'string') {
        edits = [{
          old_string: input.old_string,
          new_string: input.new_string ?? '',
          ...(input.replace_all === true ? { replace_all: true } : {}),
        }];
      }
      const body: Record<string, unknown> = {
        expected_version: input.expected_version,
        edits,
      };
      return JSON.stringify(await api('POST', `/api/nooks/${editNookId}/notes/${noteId}/edit`, body));
    }

    case 'edit_note_agent': {
      // Handled in chat.ts (needs main-loop access to sys prompt /
      // messages for inherit-mode prefix). This dispatcher case
      // shouldn't execute in practice — guard so a wiring mistake
      // produces a clear error instead of a silent fall-through.
      throw new Error('edit_note_agent must be handled by chat.ts main loop, not chat-tools.executeTool');
    }

    case 'get_current_editor':
    case 'get_current_editor_toc':
    case 'get_current_editor_part':
    case 'edit_current_editor':
    case 'get_current_location':
    case 'get_current_selection':
    case 'read_clipboard':
    case 'get_client_info': {
      // These dispatch back to the frontend — their results come in on
      // /chat/tool-result with `frontend_result`. If they ever reach the
      // executor it means the frontend-tool routing (see FRONTEND_TOOLS
      // in chat.ts) missed them; fail loud so the wiring mistake is
      // obvious rather than silently 500-ing on the API.
      throw new Error(`${name} is a frontend-executed tool and must not reach chat-tools.executeTool`);
    }

    case 'read_note_lines': {
      const targetNook = typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim() : nookId;
      const note = await api('GET', `/api/nooks/${targetNook}/notes/${noteId}`) as {
        note?: { content?: string; version?: number; title?: string };
      };
      const content = String(note?.note?.content ?? '');
      const version = note?.note?.version ?? 0;
      const title = note?.note?.title ?? '';
      const lines = content.split('\n');
      const total = lines.length;
      // 1-indexed inclusive bounds, clamped to file. `Math.max(1, ...)` so
      // garbage input falls back to "show me the start" rather than empty.
      const startRaw = typeof input.start_line === 'number' ? Math.floor(input.start_line) : 1;
      const endRaw   = typeof input.end_line   === 'number' ? Math.floor(input.end_line)   : total;
      const start = Math.max(1, Math.min(total, startRaw));
      const end   = Math.max(start, Math.min(total, endRaw));
      const slice = lines.slice(start - 1, end);
      // Right-align line-number gutter so wide notes don't ragged-edge.
      const gutterWidth = String(end).length;
      const numbered = slice
        .map((l, i) => `${String(start + i).padStart(gutterWidth, ' ')}: ${l}`)
        .join('\n');
      return JSON.stringify({
        title,
        version,
        total_lines: total,
        start_line: start,
        end_line: end,
        content: numbered,
      });
    }

    // ── User memory nook tools ──
    case 'memory_search': {
      if (!memoryNookId) throw new Error('AI memory nook not available');
      const params = new URLSearchParams();
      // Lean — title/id only. Follow up with memory_get(id) for any
      // memory whose content/attributes you actually need to read.
      if (input.q) params.set('q', String(input.q));
      return JSON.stringify(await api('GET', `/api/nooks/${memoryNookId}/notes?${params.toString()}`));
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
