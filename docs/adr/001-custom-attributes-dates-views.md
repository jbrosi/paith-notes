# ADR-001: Custom Attributes, Dates, and Views

**Status:** Accepted
**Date:** 2026-05-30
**Project:** Paith Notes

---

## Context

Paith Notes currently supports nooks -> types -> notes with graph and search as primary navigation. Notes have content and a type, but no structured metadata beyond that. Several converging needs require a structured attribute system:

- Per-type metadata: ratings, authors, directors, and similar fields
- Temporal querying: "what happened last summer", "books I read in 2024"
- Browsable, filterable card views for homogeneous typed collections
- AI agent integration for structured filter generation
- File attachments as structured metadata rather than a special note kind

---

## Decisions

### 1. Attribute Definitions as a First-Class Table

Attributes are not embedded in type definition JSONB. They live in a dedicated table:

```sql
type_attributes (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type_id     uuid,
  name        text,
  kind        text,          -- see Kind Catalog below
  config      jsonb,         -- kind-specific options (scale, display, etc.)
  indexed     boolean,
  created_at  timestamptz
)
```

**Attribute ordering** is stored on the type itself as an `attribute_order` JSONB array of attribute UUIDs, not as a position column on `type_attributes`. This allows child types to reorder inherited attributes without modifying the parent's attribute definitions. Attributes not listed in `attribute_order` appear after ordered ones, sorted by name.

**Why UUID v4:** Attributes must be globally unique to support hierarchical inheritance without namespace collisions -- a scoped counter breaks when child types inherit parent attributes and values need a single flat JSONB key. `gen_random_uuid()` is DB-side, consistent with how notes, links, and all other entities in Paith Notes are identified. UUIDs as JSONB keys are verbose in raw SQL but never written by hand -- always resolved from the attribute table.

**Why a table over JSONB in type definition:** Once attributes are globally unique and inherited across a type hierarchy, they are a first-class entity. A table gives correct ownership semantics, clean foreign keys, and a straightforward recursive query for inheritance.

**Name uniqueness:** Attribute `name` must be unique within the resolved attribute set (own + inherited). The backend must validate on create/update that no ancestor or descendant type already defines an attribute with the same name.

**History:** The `type_attributes` table and the `types` table must both be covered by Paith Notes' full row history mechanism. Changes to attribute definitions -- renames, kind changes, deletions, config updates -- are as significant as note edits and must be recoverable. This also provides an audit trail for understanding why a note's archived attributes look the way they do.

---

### 2. Kind Catalog (Hardcoded)

The set of attribute kinds is hardcoded in the application. New kinds require a deploy.

| Kind | Storage shape in JSONB | Config options | Index strategy |
|---|---|---|---|
| `text` | `"<uuid>": "Le Guin"` | `display`: `"line"` (default), `"paragraph"` | btree or trigram per config |
| `number` | `"<uuid>": 4` | `display`: `"plain"` (default), `"rating"`; `min`, `max`, `step` | `safe_numeric()` expression index |
| `boolean` | `"<uuid>": true` | | not indexed by default |
| `date` | `"<uuid>": "2024-03-15"` | | cast to date, btree |
| `date_range` | `"<uuid>": { "from": "2024-01-15", "to": "2024-03-20" }` | | two expression indexes on from and to |
| `select` | `"<uuid>": "sci-fi"` | `options`: `["sci-fi", "fantasy", "mystery"]` | btree |
| `file` | `"<uuid>": { "storage_key": "...", "filename": "...", "content_type": "...", "size": 1234 }` | `display`: `"download"` (default), `"preview"`, `"player"` | not indexed |

**`date_range`** enables correct overlap queries -- a note is active in July if its range spans July regardless of start/end month:

```sql
WHERE (attributes->'<uuid>'->>'from')::date <= '2025-07-31'
  AND (attributes->'<uuid>'->>'to')::date   >= '2025-07-01'
```

**`file`** replaces the current special `note.type = 'file'` mechanism. Files become a regular attribute kind, which means:
- A type can define multiple file attributes (e.g., thumbnail + full-resolution image, cover art + audio file)
- No more `applies_to` column on types, root file type seeding, or `exclude_note_types=file` graph filter
- File upload/download is scoped to the attribute, not the note

**`select`** provides constrained choice fields for genres, statuses, priorities, etc. Options are defined in config and enforced on write.

**Multi-value attributes** are out of scope for this iteration. Fields like "multiple authors" should use separate linked notes (which the graph already supports) rather than array-valued attributes.

---

### 3. Attribute Display

Each attribute kind supports a `display` option in its `config` that controls how the attribute renders on the full note view:

| Kind | Display options |
|---|---|
| `text` | `"line"` -- single-line inline (default). `"paragraph"` -- multi-line block |
| `number` | `"plain"` -- numeric value (default). `"rating"` -- star/dot widget (requires `max` in config) |
| `file` | `"download"` -- filename + download link (default). `"preview"` -- inline preview for images/PDFs. `"player"` -- audio/video player |
| `boolean` | checkbox (no options) |
| `date` | formatted date (no options) |
| `date_range` | formatted range (no options) |
| `select` | dropdown (no options) |

Display is defined per attribute definition (type-level), not per note or per view. The type author decides how "cover image" renders -- the view just decides whether to show it.

---

### 4. Hierarchical Inheritance

Types are hierarchical. A child type inherits all attribute definitions from its ancestors. Inheritance is resolved at read time via a recursive CTE -- no denormalization:

```sql
WITH RECURSIVE type_tree AS (
  SELECT id FROM types WHERE id = $1
  UNION ALL
  SELECT t.parent_id FROM types t
  JOIN type_tree tt ON t.id = tt.id
  WHERE t.parent_id IS NOT NULL
)
SELECT ta.* FROM type_attributes ta
JOIN type_tree tt ON ta.type_id = tt.id
ORDER BY ta.position;
```

**Attributes are not shared between types.** Each attribute is owned by exactly one type. The hierarchy is the mechanism for reuse -- if two types need a common attribute, it belongs on their common ancestor. Sibling types without a common ancestor do not share attributes.

This avoids ownership ambiguity, rename/delete coupling, and config conflicts.

---

### 5. Note Attribute Storage

Notes store attribute values in a flat JSONB column keyed by attribute UUID:

```json
{
  "550e8400-e29b-41d4-a716-446655440000": 4,
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8": "Le Guin"
}
```

The note is unaware of the type hierarchy. It stores whatever UUID keys have been set. The attribute table resolves which type owns which key. No type-namespacing in JSONB is needed because UUIDs are globally unique.

**Safe numeric casting to prevent index poisoning:**

```sql
CREATE OR REPLACE FUNCTION safe_numeric(text) RETURNS numeric AS $$
  SELECT CASE WHEN $1 ~ '^-?[0-9]+(\.[0-9]+)?$' THEN $1::numeric END
$$ LANGUAGE sql IMMUTABLE;
```

**Index examples:**

```sql
-- number kind
CREATE INDEX CONCURRENTLY ON notes (nook_id, safe_numeric(attributes->>'<uuid>'))
WHERE attributes->>'<uuid>' IS NOT NULL;

-- date kind
CREATE INDEX CONCURRENTLY ON notes (nook_id, (attributes->>'<uuid>')::date)
WHERE attributes->>'<uuid>' IS NOT NULL;

-- date_range kind (two indexes)
CREATE INDEX CONCURRENTLY ON notes (nook_id, ((attributes->'<uuid>'->>'from')::date))
WHERE attributes->'<uuid>'->>'from' IS NOT NULL;

CREATE INDEX CONCURRENTLY ON notes (nook_id, ((attributes->'<uuid>'->>'to')::date))
WHERE attributes->'<uuid>'->>'to' IS NOT NULL;
```

Indexes are created with `CREATE INDEX CONCURRENTLY` at attribute definition save time and dropped with `DROP INDEX CONCURRENTLY` on attribute deletion. `nook_id` is included in all indexes as the primary query scope.

---

### 6. Archive Column and Type Switching

Notes have two JSONB columns:

- `attributes` -- current type's live values, flat UUID-keyed
- `archive` -- displaced attribute values from previous types, flat UUID-keyed

On every type switch, a single atomic operation resolves both directions against the new type's visible attribute set (own + inherited):

1. Resolve UUID set visible to the new type via recursive CTE
2. Keys in `attributes` **not** in the new type's set -> move to `archive`
3. Keys in `archive` that **are** in the new type's set -> move to `attributes`

This is symmetric and idempotent. Switching back and forth produces no orphaned duplicates. Archive always contains exactly what the current type doesn't need -- no more, no less.

**Conflict resolution:** Since both directions are resolved in the same operation, a key can never exist in both `attributes` and `archive` simultaneously after a switch.

**Attribute deletion from a type definition:** Notes that have values for the deleted attribute retain the UUID key in their `attributes` JSONB. The key becomes inert -- invisible to the UI since it's no longer in the resolved attribute set. It moves to `archive` on the next type switch. No bulk migration is triggered by attribute deletion.

Archive is a UX convenience, not a data safety mechanism. Full row history is the source of truth for recovery.

---

### 7. Type Deletion

Types cannot be deleted while they have child types. The UI must present this constraint and suggest deleting or reparenting children first.

On type delete (leaf types only):

```sql
UPDATE notes SET type_id = NULL WHERE type_id = ?
```

Attributes are **not** nulled. They remain in the `attributes` JSONB as inert keys. Notes with `type_id = NULL` are excluded from attribute-based filters and views -- their attributes are considered inert until a type is reassigned, at which point the archive swap (section 6) brings back whatever fits the new type.

No bulk attribute migration. History captures the last full row state for recovery.

**UI constraint:** Type deletion must require explicit acknowledgment. Silent cascade is not permitted.

---

### 8. Saved Views

Views are named, persisted filter configurations scoped to a nook. They are nook-local because types are nook-local.

```json
{
  "name": "Reading list",
  "type_id": "550e8400-e29b-41d4-a716-446655440000",
  "filters": [
    { "attribute_id": "550e8400-e29b-41d4-a716-446655440000", "op": "gte", "value": 4 }
  ],
  "sort": { "attribute_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "dir": "desc" },
  "display": "cards"
}
```

**Filter operators:**

| Operator | Applicable kinds | Description |
|---|---|---|
| `eq`, `neq` | all | equals / not equals |
| `gt`, `gte`, `lt`, `lte` | `number`, `date` | comparison |
| `contains`, `starts_with` | `text` | substring / prefix |
| `is_null`, `is_not_null` | all | presence check |
| `in` | `select` | value in set |
| `overlaps` | `date_range` | range overlaps a given range |

Multiple filters are combined with AND. OR is out of scope for this iteration.

Views are nook-scoped (visible to all members), not user-scoped.

Views have no independent data layer -- they drive the existing search/filter infrastructure with persisted parameters.

**Navigation model:**

- **Graph** -- connection exploration, serendipity
- **Search** -- ad-hoc, cross-nook, ephemeral, handles natural language temporal queries
- **Views** -- curated, typed, nook-local, persistent, card or list display

Cross-nook temporal queries ("all notes from last summer") are search's responsibility, not views.

---

### 9. Card View Presentation

Card face is defined at the type level via the type definition JSONB, not per view:

```json
{
  "card_attributes": [
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
  ]
}
```

This declares which 2-3 attributes surface on the card face alongside title and content excerpt. The array may reference both own and inherited attribute UUIDs. Views do not override this -- presentation is the type's concern, not the query's.

Notes are not database rows. Content and title are always primary. Attributes are navigational handles, not the note's identity.

---

### 10. AI Agent Integration

The search agent reads type schemas including inherited attributes. For temporal queries:

1. Agent extracts concrete date range from natural language ("last summer" -> `2025-06-01` to `2025-08-31`)
2. Agent generates structured filter parameters, not raw SQL
3. Deterministic code builds the query
4. **Consent layer confirms the interpreted range before execution** ("Searching notes from June-August 2025 -- proceed?")

Attribute `name` in the definition provides the semantic context the agent needs to resolve which attribute is relevant per query.

---

### 11. File Migration

The current `note.type = 'file'` mechanism is replaced by the `file` attribute kind. Migration:

**New nook seeding:** Replace `ensureRootFileType` with seeding a "File" type that has a single `file` attribute (name: "File", kind: `file`, display: `preview`). This is the default type for file uploads, but users can create additional types with file attributes.

**Existing data migration (one-time):**

1. For each type with `applies_to = 'files'`, create a `file` attribute definition on that type
2. For each note with `type = 'file'`, move the file metadata (storage key, filename, content type, size) into `attributes` under the new attribute UUID
3. Remove the `applies_to` column from `note_types`
4. Remove the `type = 'file'` special case from note creation, graph filtering (`exclude_note_types`), and `PrimaryTypeSelect` filtering

This is a one-time schema migration, not a bulk note migration in the sense prohibited by this ADR (which refers to ongoing type switches).

---

## Consequences

**Positive:**

- No runtime DDL -- kind catalog is hardcoded, indexes created/dropped only on attribute definition changes
- No bulk note migrations -- ever (beyond the one-time file migration)
- Flat JSONB on notes is simple and hierarchy-unaware
- UUID keys eliminate collision risk across the type hierarchy and are consistent with all other entity IDs in the system
- Atomic bidirectional type switch keeps archive clean without special-casing
- Full row history on notes, types, and type_attributes eliminates data loss risk
- Clean navigation triad with no feature overlap
- AI temporal queries are safe: natural language -> structured params -> deterministic SQL -> consent confirmation
- Files as attributes enable multi-file types and eliminate special-casing throughout the codebase
- Display config per attribute gives type authors control over presentation without polluting view logic

**Negative / tradeoffs:**

- `type_attributes` table requires a recursive CTE for inheritance resolution -- acceptable, the tree is shallow in practice
- Index lifecycle must be reliably hooked into attribute definition save/delete path, using CONCURRENTLY to avoid locks
- `safe_numeric` function must exist before indexed number attributes can be created
- UUID keys are verbose in raw SQL when inspecting JSONB directly -- mitigated by the attribute table providing the name mapping, never written by hand
- One-time file migration required for existing nooks
- Multi-value attributes deferred -- arrays (multiple authors, tags) require linked notes for now

---

## Implementation Order

1. `type_attributes` table + history coverage for `types` and `type_attributes`
2. Recursive inheritance query + attribute name uniqueness validation
3. `attributes` + `archive` JSONB columns on notes
4. `safe_numeric` function
5. Index lifecycle: create concurrently on attribute add, drop concurrently on remove
6. Kind-aware index generation per attribute definition
7. Atomic type switch: bidirectional archive/attributes resolution
8. Type delete: prevent if children exist, null `type_id` cascade + UI constraint
9. `file` attribute kind + file upload/download scoped to attribute
10. File migration: move existing file notes to attribute-based storage, remove `applies_to` and `type = 'file'` special cases
11. New nook seeding: replace `ensureRootFileType` with default File type + file attribute
12. Attribute display config: kind-aware rendering on note view
13. Saved views: storage + filter execution with defined operator set
14. Card view: `card_attributes` in type definition (own + inherited) + rendering
15. Agent: attribute schema awareness + temporal filter generation + consent confirmation
