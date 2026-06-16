# ADR-001: Custom Attributes, Dates, and Views

**Status:** Implemented (core), In Progress (views, card view, agent)
**Date:** 2026-05-30
**Updated:** 2026-06-01
**Project:** Paith Notes

---

## Context

Paith Notes supports nooks -> types -> notes with graph and search as primary navigation. Several converging needs required a structured attribute system:

- Per-type metadata: ratings, authors, directors, and similar fields
- Temporal querying: "what happened last summer", "books I read in 2024"
- Browsable, filterable card views for homogeneous typed collections
- AI agent integration for structured filter generation
- File attachments and graph views as structured metadata rather than special note kinds

---

## Decisions

### 1. Attribute Definitions as a First-Class Table

Attributes live in a dedicated table with `nook_id` for direct scope enforcement:

```sql
type_attributes (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nook_id     uuid NOT NULL REFERENCES nooks(id),
  type_id     uuid NOT NULL REFERENCES note_types(id),
  name        text NOT NULL,
  kind        text NOT NULL,  -- see Kind Catalog below
  config      jsonb DEFAULT '{}',
  indexed     boolean DEFAULT false,
  created_at  timestamptz,
  updated_at  timestamptz,
  history_id  bigint,     -- audit trigger
  version     int DEFAULT 0  -- audit trigger
)
```

**Attribute ordering** is stored on the type itself as an `attribute_order` JSONB array of attribute UUIDs. This allows child types to reorder inherited attributes without modifying the parent's definitions. Attributes not listed in `attribute_order` appear after ordered ones, sorted by name.

**Automatic indexing:** Indexable kinds (text, number, date, date_range, select) are automatically indexed when created or updated. No manual `indexed` toggle is exposed -- the system decides based on kind.

**Name uniqueness:** Attribute `name` must be unique within the resolved attribute set (own + inherited). Validated against both ancestor and descendant types on create/update.

**History:** Both `note_types` and `type_attributes` are covered by the audit trigger system. Full row snapshots are captured on every INSERT/UPDATE/DELETE.

---

### 2. Kind Catalog (Hardcoded)

The set of attribute kinds is hardcoded. New kinds require a deploy.

| Kind | Storage shape in JSONB | Config options | Index strategy |
|---|---|---|---|
| `text` | `"<uuid>": "Le Guin"` | `display`: `"line"` (default), `"paragraph"` | btree on text extraction |
| `number` | `"<uuid>": 4` | `display`: `"plain"` (default), `"rating"`; `max` | `safe_numeric()` expression index |
| `boolean` | `"<uuid>": true` | | not indexed |
| `date` | `"<uuid>": "2024-03-15"` | | `::date` cast, btree |
| `date_range` | `"<uuid>": { "from": "...", "to": "..." }` | | two indexes on `from` and `to` |
| `select` | `"<uuid>": "sci-fi"` | `options`: `["sci-fi", "fantasy", ...]` | btree |
| `file` | `"<uuid>": { "storage_key": "...", "filename": "...", "content_type": "...", "size": 1234, "checksum": "..." }` | `display`: `"download"` (default), `"preview"`, `"player"` | not indexed |
| `graph` | `"<uuid>": { "rootNoteId": "...", "depth": 2, "layout": "force", ... }` | | not indexed |

**`graph`** replaces the former `note.type = 'graph'` mechanism. Graph view notes are just notes with a type that has a `graph` attribute. The frontend discovers graph attributes and renders the interactive graph panel.

**`file`** replaces the former `note.type = 'file'` mechanism. A type can have multiple file attributes (thumbnail + full-res, cover art + audio).

**Multi-value attributes** are out of scope. Use linked notes instead.

---

### 3. Attribute Display

Each kind supports a `display` option in `config`:

| Kind | Display options |
|---|---|
| `text` | `"line"` -- single-line input (default). `"paragraph"` -- textarea |
| `number` | `"plain"` -- number input (default). `"rating"` -- star widget (★) with configurable `max` |
| `file` | `"download"` -- link (default). `"preview"` -- inline image/PDF. `"player"` -- audio/video |
| `graph` | interactive graph panel (no options) |
| `boolean` | checkbox (no options) |
| `date` | date picker (no options) |
| `date_range` | dual date pickers (no options) |
| `select` | dropdown (no options) |

Display is per attribute definition (type-level), not per note.

---

### 4. Hierarchical Inheritance

Child types inherit all attributes from ancestors. Resolved at read time via recursive CTE:

```sql
WITH RECURSIVE type_tree AS (
  SELECT id FROM note_types WHERE id = $1
  UNION ALL
  SELECT t.parent_id FROM note_types t
  JOIN type_tree tt ON t.id = tt.id
  WHERE t.parent_id IS NOT NULL
)
SELECT ta.* FROM type_attributes ta
JOIN type_tree tt ON ta.type_id = tt.id;
```

Results are sorted by the requesting type's `attribute_order` array, with unordered attributes falling back to alphabetical.

---

### 5. Note Attribute Storage

Notes store values in a flat `attributes` JSONB column keyed by attribute UUID. The `archive` JSONB column holds displaced values from type switches.

```json
{
  "550e8400-...": 4,
  "6ba7b810-...": "Le Guin"
}
```

Legacy columns `type`, `properties`, and `former_properties` have been dropped from the notes table. Legacy column `applies_to` has been dropped from note_types.

**Index lifecycle:** Expression indexes are created/dropped automatically when attributes are created, updated, or deleted. Index name: `idx_notes_attr_<uuid_prefix>`. All indexes include `nook_id` as the leading column.

---

### 6. Archive Column and Type Switching

On type switch, a bidirectional swap resolves both directions:

1. Resolve visible attribute UUIDs for the new type via CTE
2. Keys in `attributes` not in the new set -> move to `archive`
3. Keys in `archive` that are in the new set -> move to `attributes`

Symmetric, idempotent, no orphans.

---

### 7. Type Deletion

Types cannot be deleted while they have child types. On delete:

```sql
UPDATE notes SET type_id = NULL WHERE type_id = ?
```

Attributes remain as inert JSONB. They resurface via archive swap when a compatible type is reassigned.

---

### 8. Attribute-Driven Frontend

The frontend does not check `note.type`. Instead:

1. Load note's `type_id` -> resolve attributes via API
2. For each attribute, render the appropriate widget based on `kind`
3. `text` -> input/textarea, `number` -> number/stars, `file` -> upload/preview, `graph` -> graph panel

Title + content are always present. Everything else is discovered from attributes.

**Default type seeding:** New nooks get a "File" type (with a `file` attribute, display: preview) and a "Graph View" type (with a `graph` attribute). The "Upload file" button finds any type with a file attribute.

---

### 9. Saved Views (Not Yet Implemented)

Views are named, persisted filter configurations scoped to a nook.

---

### 10. Card View (Not Yet Implemented)

`card_attributes` JSONB array on note_types defines which attributes surface on card faces.

---

### 11. AI Agent Integration (Not Yet Implemented)

Agent reads type schemas including inherited attributes for structured filter generation.

---

## Consequences

**Positive:**

- No runtime DDL -- kind catalog is hardcoded, indexes managed on attribute definition changes
- No bulk note migrations
- Flat JSONB on notes is simple and hierarchy-unaware
- UUID keys eliminate collision risk across the type hierarchy
- Atomic bidirectional type switch keeps archive clean
- Full row history on notes, types, and type_attributes
- Files and graphs are regular attributes -- no special note kinds
- Display config per attribute gives type authors control over presentation
- Automatic indexing for filterable/sortable kinds

**Negative / tradeoffs:**

- Recursive CTE for inheritance resolution (shallow trees in practice)
- Index lifecycle hooked into attribute save/delete path
- UUID keys verbose in raw SQL (mitigated by attribute table name mapping)
- Multi-value attributes deferred

---

## Implementation Status

| # | Item | Status |
|---|---|---|
| 1 | `type_attributes` table + audit history | Done |
| 2 | Recursive inheritance + name uniqueness | Done |
| 3 | `attributes` + `archive` on notes | Done |
| 4 | `safe_numeric` function | Done |
| 5 | Index lifecycle (create/drop) | Done |
| 6 | Kind-aware index generation (incl. date_range) | Done |
| 7 | Atomic type switch | Done |
| 8 | Type deletion guard | Done |
| 9 | `file` kind + attribute-based upload/download | Done |
| 10 | `graph` kind + attribute-driven rendering | Done |
| 11 | Legacy removal (type/properties/applies_to columns dropped) | Done |
| 12 | Default nook seeding (File + Graph View types) | Done |
| 13 | Attribute display config (rating, paragraph, preview) | Done |
| 14 | Attribute ordering (`attribute_order` on types) | Done |
| 15 | Saved views | Not started |
| 16 | Card view (`card_attributes`) | Not started |
| 17 | Agent attribute awareness | Not started |
