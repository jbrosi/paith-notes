# Vision for ai/chat — Implementation Plan

Goal: let the chat model **see images** (vision), and let it **save attached/pasted
images as notes** (new note, or attached to an existing note). Paith-low is
text-only (no mmproj); paith-high (27B VL) is vision-capable. Paith-low stays the
default; vision works on paith-high.

Status legend: [x] done · [~] in progress · [ ] not started

> This file is kept in sync with the code as work happens. If you find a
> mismatch, the code is the source of truth — fix the plan in the same change.

## The data flow (the whole feature in one picture)

```
browser paste/drop ──► imageAttach.processImageAttachment()
                          ├─ original (full-res)  ── uploaded ──► POST /chat images[]
                          └─ preview  (≤1024)     ── LOCAL ONLY (thumbnail render)
                                                    │
POST /chat  images:[{data, media_type, filename}]   │   (data = ORIGINAL bytes)
                                                    ▼
                                            MCP /chat route
                          normalizeChatImage()  ── reads `data`, rejects bad/oversized
                                                    │
              ┌─────────────────────────────────────┼─────────────────────────────────────┐
              ▼                                     ▼                                     ▼
   1. STORE (always)                     2. VISION (paith-high only)          3. FALLBACK (turn-local)
   POST /api/conversations/             imageToBlock() → resizeForVision()    turn-images.ts stash
     {cid}/images                        (sharp, ≤1024) → Anthropic `image`   ORIGINAL bytes by
   ChatAttachmentsController              content block                         [IMAGE n] index
   → ORIGINAL bytes to disk                │                                     (only if 1 fails)
     chat/{cid}/images/{uuid}.ext          ▼
   → row in global.conversation_images   model sees resized pixels only
     (uuid + conversation-wide [IMAGE n]) │
              │                            │
              └──► transcript marker ──────┴──► [IMAGE n] id=<uuid>
                        (no bytes in the prompt)
                                │
                ┌───────────────┴────────────────┐
                ▼                                ▼
   look_at_image(image_id | note_id)   save_image_to_note(attachment_id)
   GET …/{cid}/images/{uuid}            POST /api/nooks/{n}/chat-images/from-attachment
   or GET …/notes/{nid}/image           ChatImagesController — server-side COPY,
   → resizeForVision → real `image`     ORIGINAL bytes, FULL RESOLUTION
     block in the tool_result           → note + global.note_files row
```

Two invariants the design exists to guarantee:
1. **A saved image is always full resolution.** Resizing happens only for the
   vision payload; the save path receives the untouched original.
2. **Image bytes never travel through the LLM.** The model only ever sees
   resized pixel blocks (when it supports vision) plus a tiny `[IMAGE n] id=…`
   marker. It cannot echo back a base64 blob, so there is no token blowup and
   no accidental leak of the image into the prompt/history.

Lifetime: an attachment lives exactly as long as its conversation. Rows
`ON DELETE CASCADE`; the bytes are unlinked explicitly by
`ConversationsController` (a DB cascade cannot reach the filesystem).
`attachment_index` is append-only per conversation, so `[IMAGE n]` always names
the same picture even after twenty later turns.

## Decisions (agreed)
- Default model stays `paith-low`.
- Vision gated to `paith-high` (verified working via LiteLLM `paith-high`).
- On a non-vision model (paith-low): the model CANNOT see the image, but it CAN
  still SAVE it. A per-turn hint tells the model: "you can save this image (no
  vision needed) but you cannot describe it — suggest Paith High for that."
- Model selector labels: `paith-high` marked vision-capable ("Paith High · 👁").
- **Resizing is server-side** (node + sharp), not in the browser. One payload
  (the original) goes over the wire; the resize happens once, at the moment the
  vision block is built. The browser still makes a small `preview` for its own
  thumbnails but never uploads it.
- Max dimension for the vision payload: **1024px** (see "Token cost").
- Image format: the ORIGINAL always keeps its true format (that's what gets
  stored). For the vision payload, a PNG source keeps alpha as PNG; anything
  else becomes JPEG q85.
- The model must be able to:
  - read images **embedded in note content** (`![alt](note:UUID)`) or **attached
    to a note** (image file on the note).
  - take a **pasted (Ctrl+V) image** and either **create a new note** from it or
    **attach it to the current note**.

## Token cost (why we cap resolution)
Anthropic-style vision tokenizes an image into ~512px tiles (≈170 tokens/tile);
total ≈ (w/512)*(h/512)*170, plus a fixed base. A 4096x4096 image ≈ 10,000+
tokens. Capping the max dimension at 1024px → worst case ~680 tokens/image.
Token cost tracks PATCHED PIXELS, not file bytes — that's why the cap is a
pixel dimension and not a file-size limit.

## Backend — MCP (`app/mcp/src/`) — [x] done
- [x] `chat.ts`: `VISION_MODELS = new Set(['paith-high'])` + `modelSupportsVision()`.
- [x] `chat.ts`: `ChatImage` (`{data, media_type?}`), `normalizeChatImage()`
      (reads `data`; rejects non-objects, empty, >20M chars), caps
      `MAX_CHAT_IMAGES = 4`.
- [x] `chat.ts`: async `imageToBlock()` → resized Anthropic `image` block; returns
      `null` on failure so a bad image degrades to "no vision" rather than
      breaking the turn.
- [x] `chat.ts` `/chat` route: builds `content = [text, ...imageBlocks]`;
      image blocks only exist for vision-capable models.
- [x] `chat.ts`: `[IMAGE n] media_type=…` markers carry **no bytes** — just the
      index the model needs to call `save_image_to_note`.
- [x] `chat.ts`: `setTurnImages()` on entry; the route's `finally` clears the
      stash **only when the turn didn't park on an approval** (see bug 2 —
      approved tools run in the next request).
- [x] `chat.ts`: per-turn `visionHint` for non-vision models (save vs. can't
      describe — suggest Paith High, don't guess).
- [x] `image-resize.ts` (new): `decodeImage()` (data: URI or bare base64 →
      Buffer, no re-encode) + `resizeForVision()` (sharp, ≤1024px, PNG when the
      source has alpha else JPEG q85, ENCODE-failure fallback).
- [x] `image-resize.ts`: sharp is imported **lazily** so a missing/mismatched
      native binary can't take the whole `/chat` route down — the failure stays
      confined to the vision path and saving still works.
- [x] `turn-images.ts` (new): per-conversation stash of the ORIGINAL bytes,
      1-based index, 10-min TTL sweep, plus `parkedToolsNeedImages()` (which
      parked tools read the stash). Own module to avoid the
      `chat.ts → chat-tools.ts → image-save.ts → chat.ts` import cycle.
- [ ] (optional) image-token estimate in the context-pressure hint.

## Backend — MCP tool `save_image_to_note` — [x] done
- [x] `tools/image-save.ts`, registered in `registry.ts`. Inputs:
      `attachment_id` (preferred — the stored full-res bytes are copied
      server-side, works for an image from ANY earlier turn), `image_index`
      (fallback when the store was unreachable at paste time), `image_data`
      (last resort), `media_type?`, `title?`, `filename?`, `note_id?`
      (attach mode), `nook_id?`.
- [x] NOT auto-approved (it's a write) → user approval card; listed in
      `ORDER_SENSITIVE_WRITE_TOOLS`.
- [x] `attachment_id` → `POST /api/nooks/{nookId}/chat-images/from-attachment`
      (no base64 through the model). Fallbacks → `POST …/chat-images`.
      Both with `X-Nook-Actor: ai`.
- [x] Works on paith-low too: saving never needs vision.

## Durable attachments + re-looking (2026-10-04, second pass) — [x] done
The gap this closes: the original bytes used to live in a process-local
`Map` for one turn, so "analyse this screenshot, then save it as a note"
was impossible, and the model could never look at a picture again — including
one it had just saved into a note.
- [x] `global.conversation_images` (GlobalSchema): uuid `id`,
      `conversation_id` + `turn_id?` + `nook_id?`, append-only
      `attachment_index` per conversation (unique with the conversation),
      `filename`, `media_type`, `filesize`, `checksum`, `object_key`,
      `ON DELETE CASCADE`.
- [x] `ChatAttachmentsController` + `LocalObjectStore` (object paths shared with
      note files so the files sidecar/backup covers them):
      `POST /conversations/{cid}/images` (batch, transactional — a rejected
      batch leaves neither rows nor files), `GET …/images` (metadata),
      `GET …/images/{imageId}` (ORIGINAL bytes + `X-Image-Mime` /
      `X-Image-Filename`), `GET /nooks/{n}/notes/{nid}/image` (current image of
      a note; 415 for a non-image, 404 when the note has none).
- [x] `ConversationsController::delete` / `deleteAll` sweep
      `chat/{cid}/` from disk (a DB cascade cannot unlink bytes) and collect the
      ids BEFORE deleting.
- [x] MCP `chat-attachments.ts` (new): `storeAttachments`,
      `fetchAttachmentBytes`, `fetchNoteImageBytes`, mime normalize + magic-byte
      sniffing. `/chat` uploads the originals first (a failed upload degrades to
      the turn stash, it never fails the turn).
- [x] `look_at_image` (`tools/image-view.ts`, new, auto-approved read) with
      `image_id` (chat attachment, any turn) or `note_id` (current image of a
      note). Returns a text block + a real `image` block; a text-only model gets
      an honest message and is told to suggest Paith High, without any download.
- [x] `ToolResultContent` (`string | (TextBlockParam|ImageBlockParam)[]`) is
      passed through `/chat` and `/chat/tool-result` instead of being
      `JSON.stringify`-d, so a tool can hand the model actual pixels.
- [x] Every `executeTool` call site (`/chat`, `/chat/tool-result`, search agent,
      edit agent) now passes the resolved `model`. Without it `ctx.model` is
      undefined, `modelSupportsVision('')` is false, and `look_at_image` would
      tell a vision-capable model it cannot see images — silently, forever.
      Regression test drives it through `executeTool`.
- [x] `modelSupportsVision` moved to `vision-model.ts` (leaf module) — importing
      it from `chat.ts` created `registry → tool → chat → registry`, which threw
      `Cannot access 'imageViewTools' before initialization` at module load.
      Re-exported from `chat.ts` for compatibility.
- [x] System prompt + tool descriptions now say: read metadata is never enough,
      call `look_at_image`, never guess a picture from its filename.

## Backend — PHP (`app/api/`) — [x] done
- [x] `Http/Controller/ChatImagesController.php` (new), registered in
      `ApiRoutes.php` as `POST /nooks/{nookId}/chat-images`.
- [x] New-note mode: bootstraps the `file` type + file attribute, inserts the
      note + `note_files` row, writes the original bytes to disk.
- [x] Attach mode: adds a new version on an existing image note.
- [x] Sniffs mime (png/jpeg/gif/webp) when `media_type` is absent; strips
      `data:` URIs; caps payload (44M base64 chars / 40MB decoded).
- [x] Persistence of image content blocks in chat history:
      `ConversationsController.appendMessages` is already generic (stores any
      block JSON) — verified, no change needed.

## Bounding what the pixels cost — [x] done
Two growth paths came out of making images durable/re-viewable; both are now
closed rather than left for later.
- [x] `chat/image-budget.ts` (new): `stripStaleImageBlocks(history, {keep: 4})`,
      applied to the REQUEST copy only (same approach as
      `sanitizeOrphanedToolUses`, never written back). Keeps the newest distinct
      tool_result image blocks and replaces older ones with a text stub telling
      the model to call `look_at_image` again. Without it a model that re-looks
      at the same picture every turn adds ~1.5k tokens per turn, forever, since
      tool_results are persisted and re-sent. Deliberately does NOT strip the
      user's own pasted image blocks — those are bounded by how many times the
      user pasted, and the UI shows them.
- [x] Orphan-file reaper in the worker (`Runner::cleanupOrphanedChatImages`),
      joined to the existing 30s `runCleanupOnce()` sweep: deletes files under
      `chat/<cid>/images/` that no row references, skipping anything younger than
      1 hour (a request mid-write must never be a candidate). Index added on
      `conversation_images(object_key)` so the per-file lookup isn't a seq scan.
      Note: `run()` previously called `cleanupExpiredUploads()` directly, so a
      new sweep added only to `runCleanupOnce()` would have looked tested and
      never run in production — both now go through the one entry point.
- [x] The per-turn paith-low hint taught the old `image_index` contract; it now
      says `attachment_id`, mentions that `look_at_image` will refuse on this
      model, and reassures the user the attachment is stored (no re-send needed).

## Frontend (`app/frontend/src/components/chat/`) — [x] done
- [x] `imageAttach.ts` (new): `processImageAttachment()` → `{original, preview,
      mediaType, filename}`; `original` is NEVER resized, `preview` is
      ≤1024px and **local-only**. `extractImageBlobs()` for paste/drop items.
- [x] `ChatInput.tsx`: 📎 button + hidden file input, `onPaste`, drag-and-drop,
      thumbnails with remove, cap of 4 attachments. `SendMeta.images`.
      `MODELS` + `MODEL_SUPPORTS_VISION` exported for the "· 👁" badge.
- [x] `ChatPanel.tsx`: POSTs `images: [{data: original, media_type, filename}]`
      — the original only. Also surfaces stored `image` blocks as data-URI
      thumbnails so attachments re-render after a reload.
- [x] `ChatMessage.tsx`: renders user-attached images above the text.
- [x] `ChatInput.module.css`: attach button / row / thumbnail / remove / loading.
- [x] `tsc --noEmit`, `biome check`, `stylelint` all clean.

## Paste-to-note
- [x] Via the AI tool path: attach an image + "save this" / "attach it to
      <note>" → model calls `save_image_to_note` (user approves). Covers both
      "create note" and "attach to current note".
- [ ] (optional, later) one-click "📎 → save as note" bypassing the AI.

## Tests — [x] done
- [x] MCP `src/chat-vision.test.ts`: `modelSupportsVision` (3), `normalizeChatImage`
      (4), `decodeImage` (3, incl. full-res bytes are bit-identical),
      `imageToBlock` (2), `resizeForVision` (5 — caps 1024 on the long side,
      aspect preserved, never enlarges, PNG-with-alpha vs JPEG, data: URI),
      turn-image stash (4), **approval round-trip retention (4 — regression
      guard for bug 2)**. **Full MCP suite: 85/85 pass.**
- [x] PHP `tests/Feature/ChatImagesTest.php` (new, 11 tests): new-note creation at
      full resolution (bytes byte-identical + original pixel dimensions),
      checksum + single `note_files` row, attach as a new version, third attach
      → v3, refuses a note with no file, 404 unknown note, `data:` URI + mime
      sniffing, rejects non-image payload, rejects missing `image_data`, title
      fallback, requires auth.
      **Full PHP suite: 325/325 pass.**
- [x] MCP `src/chat-attachments.test.ts` (new, 21 tests, all with `fetch`
      stubbed — no LLM, no network): store payload/ordering, API failure,
      non-JSON body, malformed rows dropped, mime normalize + sniffing +
      header fallback, `look_at_image` returns decodable pixels for
      `image_id`/`note_id`/cross-nook, refuses on paith-low WITHOUT fetching,
      404 passthrough, undecodable bytes, missing args, no-nook refusal;
      `save_image_to_note` copies by `attachment_id` without resending base64,
      attach mode, works on paith-low, API failure, no id-guessing.
      + 2 through `executeTool` (guards the model plumbing below).
      **Full MCP suite: 117/117 pass.**
- [x] PHP `tests/Feature/ChatAttachmentsTest.php` (new, 17 tests): full-res
      bytes on disk, `data:` URI + sniffing, append-only indexes across turns,
      read-back of the original, cross-conversation + cross-user denial, junk /
      empty / oversized batch rejected, mid-batch failure cleans up files AND
      rolls back rows, from-attachment copy is byte-identical at full res,
      attach → v2 while the attachment stays intact, foreign attachment refused,
      delete removes rows AND bytes, delete-all sweeps everything, one
      conversation's delete spares another, note image endpoint (newest version,
      404 for a fileless note), note image not readable across nooks.
- [x] MCP `src/chat/image-budget.test.ts` (new, 9): newest pixels kept, older
      ones stubbed with an actionable notice, budget respected, a re-look at the
      same image counted once, pasted attachments never stripped, tool_use
      pairing + block count preserved, idempotent, does not mutate the caller's
      history.
- [x] Worker `tests/Feature/CleanupOrphanedChatImagesTest.php` (new, 5): keeps a
      file with a row, deletes one whose row was never written, deletes one whose
      conversation is gone, leaves a fresh file alone, never touches note files.
- [x] phpstan level 10 clean (only pre-existing `is_array()` noise in
      `AiImagesController`/`NookExportController` from a newer local phpstan);
      phpcs (PSR12) clean.
- [ ] E2E in the browser: paste image on paith-high → model describes it; on
      paith-low → model offers to save / suggests Paith High; ask it to save →
      note created at full resolution; attach to an existing image note → v2.
      (Needs an authenticated browser session — do this in the running app UI.)

## Bugs found & fixed (2026-10-04 session resume)
1. **Contract mismatch — the feature was dead end-to-end.** The frontend posted
   `{preview, media_type, original, filename}` but `normalizeChatImage()` only
   reads `data`, so *every* image was silently dropped: no vision block, nothing
   stashed, nothing saveable. Frontend now posts `{data: original, …}`. Side
   benefit: the request payload halves (we no longer upload both copies).
2. **The approval round-trip deleted the images before the tool could read
   them.** `save_image_to_note` is a write, so it always parks on an approval
   card: `streamConversation` pushes `awaiting_approval` and **returns**, which
   runs the `finally` that cleared the turn stash. The tool doesn't execute
   there — it executes in the *next* request (`POST /chat/tool-result` →
   `executeTool`). So the approved tool woke up to an empty stash and failed
   with "no attached image at index 1", every single time. This is why the
   transcript shows the model retrying the same call three times and then
   blaming "attachment sync".
   Fix: `streamConversation` now reports whether it parked on a tool that reads
   the stash (`parkedToolsNeedImages()`, living in `turn-images.ts` next to the
   stash it protects). The `finally` only clears when it did *not* park; each
   route clears afterwards unless the continuation parked on another
   image-consuming tool (so chained approvals still work). The 10-min TTL
   backstops an approval the user never answers.
3. **Attach mode always 500'd.** `global.note_files` is keyed by
   `note_id uuid PRIMARY KEY` (one row per note), but `attachToExistingNote()`
   INSERTed a second row → `23505 duplicate key … note_files_pkey`. Now UPDATEs
   the row in place, mirroring `AiImagesController::persistAsRefinement()`, and
   advances the note's `attributes` JSONB `file_version` pointer (which the old
   code's comment claimed but never did). Guarded by a regression test.
4. **`sharp` would not have loaded in Docker.** The MCP Dockerfile is
   `node:22-alpine` (musl) but `yarn.lock` only had resolved entries for the
   glibc `@img/sharp-linux-x64` / `…-libvips-linux-x64` — the musl variants
   appeared only inside sharp's `optionalDependencies` list, with no resolved
   entries. `yarn install --frozen-lockfile` therefore skipped the native
   binary. Added both musl entries (integrity hashes taken from the npm
   registry).
5. **A sharp load failure would have taken down all of `/chat`.** sharp is now
   imported lazily inside `resizeForVision()`, so the blast radius is the vision
   path only; attachments still save at full resolution.
6. `src/chat-vision.test.ts` referenced a removed `imageToBuffer` helper, so
   `tsc` / `npm run build` was failing. Retargeted to `decodeImage`.

### The tool-error message matters
When the stash is legitimately gone (the `[IMAGE n]` came from an *earlier*
message — the bytes are per-turn), the tool used to say only "no attached image
at index 1". The model then looped: retried, blamed a sync glitch, and asked
the user to refresh the browser. The error now states that the bytes only live
for the turn they were pasted in and explicitly tells the model not to retry or
ask for a refresh — just say the image must be re-attached.

## Known gaps / follow-ups
- [ ] TODO: **add a linter to `app/mcp`** — it has none (the frontend has
      `biome` + `stylelint`; PHP has phpstan + phpcs), so MCP is only covered by
      `tsc --noEmit`. Run `npx eslint src` today and it fails outright: eslint
      wants an `eslint.config.*` flat config that does not exist. Cheapest parity
      is `biome` like the frontend (`biome check ./src`) plus an `npm run verify`
      = `biome check ./src && tsc --noEmit`. Until then the new image code
      (`src/tools/image-view.ts`, `src/chat-attachments.ts`,
      `src/tools/image-save.ts`) is type-checked but unlinted — and note this
      file's own tabs/spaces inconsistency (`src/chat-attachments.ts` is
      tab-indented like the rest of `src`, `src/tools/image-view.ts` is
      space-indented) is exactly the kind of thing a formatter would have caught.
- [ ] TODO: verify the musl/sharp fix on a real alpine build — no Docker in the
      dev container, so it was validated by lockfile inspection + registry
      integrity only.
- [ ] TODO: run `tests/Feature/ChatAttachmentsTest.php` (api) and
      `tests/Feature/CleanupOrphanedChatImagesTest.php` (worker) against a real
      Postgres. Written, `php -l`/phpcs/phpstan clean, but the dev container has
      no `pdo_pgsql` driver and no reachable `db` host, so neither has actually
      executed. Same for a container-level end-to-end check of `/chat` uploading
      to the store.
- [ ] TODO: the orphan reaper re-scans `chat/*/images/` every 30s. Fine at
      current volume; if conversations pile up it wants a marker (e.g. only sweep
      dirs whose conversation row is gone) instead of a full walk.
- [ ] Optional: re-render a reloaded chat's images from
      `GET /conversations/{cid}/images/{id}` (the full-res original) instead of
      the ≤1024px copy stored in the conversation block. Works today via the
      block; it just shows a downscaled thumbnail.
- [ ] (optional) image-token estimate in the context-pressure hint.
- [ ] (optional) one-click "save as note" that bypasses the AI.

## Out of scope (for now)
- Vision on paith-low (needs mmproj on the Ollama server — user will handle).
- Streaming image *output* (generate_image already exists for that).
- Version history UI for chat-saved images (prior versions stay on disk, but
  nothing browses them yet).

## 2026-10-05 Status Update (after local DB tests)

- **PHP suites (no Docker):** API 344 passed (1452 assertions), worker 22 passed (34 assertions), 0 warnings. ChatAttachmentsTest 19 passed, ChatImagesTest 11 passed. `resolveMime` now enforces byte-only sniffing (rejects mislabelled/junk payloads). Conversation deletion sweeps the full `chat/{id}` tree with emptiness guards (no leftover empty dirs).
- **Docker test stack:** `docker-compose.api-tests.yml` now includes an `api` service (dev target), both services get `FILES_DATA_PATH=/data` and mount a shared `files_data` volume; `scripts/run-api-tests.sh` installs dev dependencies when missing and runs API and worker suites. `docker/app/Dockerfile` and `docker/worker/Dockerfile` added `gd` (freetype/jpeg/webp) to support `imagecreatetruecolor()` in tests.
- **Static checks:** API-touched PHP clean under repo PHPStan config; PHPCS 0 errors (baseline warnings). MCP `tsc --noEmit` clean; new MCP tests (chat-attachments + image-budget) pass (15/15 passing on vitest).
- **Known:** Worker PHPStan still reports many pre-existing style/type issues when run from worker dir with root config (unrelated to our changes). MCP has no linter configured (documented TODO). No live E2E on running app yet; tests are fully mocked/stubbed.
