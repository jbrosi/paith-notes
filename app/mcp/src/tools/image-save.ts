import type { ToolModule, ToolHandlerContext } from './types.js';
import { getTurnImage } from '../turn-images.js';
import { decodeImage } from '../image-resize.js';

// Persist an image the user attached to a chat message as a note — either a
// NEW file-typed note, or a NEW VERSION on an existing note. Posts the
// ORIGINAL (un-resized) base64 to the PHP /chat-images endpoint, so the note
// keeps full resolution. Resizing only ever applies to the vision path (what
// the model sees), never to what's stored.
//
// Always a WRITE → never auto-approved; the user sees an approval card.

const definitions: ToolModule['definitions'] = [
  {
    name: 'save_image_to_note',
    description:
      "Save an image as a note. Two modes:\n" +
      "- NEW note: omit `note_id`. Creates a file-typed image note in the target nook (default: the current nook) and returns its id + a `![…](note:ID)` embed you can drop into other notes.\n" +
      "- ATTACH to an existing note: pass `note_id`. Adds the image as a new version on that note. Only works if that note already carries a file (image) — otherwise the call errors and you should create a new note instead.\n\n" +
      "## When to use\n" +
      "The user pasted or attached an image in chat, or is looking at one with look_at_image, and wants it kept: \"save this\", \"make a note of this picture\", \"attach this to <note>\", \"turn this screenshot into a note\". Do NOT use this for AI-GENERATED images (that's generate_image). This is for the user's own pictures.\n\n" +
      "## Inputs\n" +
      "- `attachment_id`: the `id=<uuid>` from an `[IMAGE n] id=<uuid>` marker — the image the user pasted into this conversation. Preferred: the full-resolution bytes are already stored, so saving is a server-side copy and works for an image from ANY earlier message of this conversation.\n" +
      "- `image_index`: 1-based [IMAGE n] index. Fallback ONLY when there is no attachment_id (e.g. the attachment store is unavailable); resolves the bytes of THIS turn's paste.\n" +
      "- `image_data`: OPTIONAL — a base64 image to save directly. Last resort, when there is neither an attachment nor a turn index.\n" +
      "- `media_type`: e.g. `image/png` or `image/jpeg`. Only needed with `image_data`.\n" +
      "- `title`: a short human-readable name for the new note (only for the new-note mode). Derive it from what the image shows + any context the user gave.\n" +
      "- `filename`: optional, e.g. `screenshot.png`. Defaults to the stored filename.\n" +
      "- `note_id`: the UUID of an existing note to attach to (attach mode). Omit to create a new note.\n" +
      "- `nook_id`: target nook UUID for the new note. Omit to use the current nook.\n\n" +
      "## Choosing the mode\n" +
      "If the user named a specific note (\"attach it to my Meeting note\"), resolve that note's id first (search_notes / get the current note) and pass note_id. If they just said \"save this\" with no target, create a new note. When unsure which existing note they meant, ASK — never guess between candidate notes.",
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: {
          type: 'string',
          description: 'The id=<uuid> from an [IMAGE n] id=<uuid> marker. Preferred — resolves the stored full-resolution bytes.',
        },
        image_index: {
          type: 'integer',
          description: 'Fallback: the 1-based [IMAGE n] index of an image pasted in THIS turn, when no attachment_id is available.',
        },
        image_data: {
          type: 'string',
          description: 'Last resort: base64 image to save directly, when there is neither an attachment id nor a turn index.',
        },
        media_type: {
          type: 'string',
          description: 'MIME type, e.g. image/png or image/jpeg. Only needed with image_data.',
        },
        title: {
          type: 'string',
          description: 'Short title for the NEW note (new-note mode only).',
        },
        filename: {
          type: 'string',
          description: 'Optional filename, e.g. screenshot.png.',
        },
        note_id: {
          type: 'string',
          description: 'UUID of an existing note to attach the image to (attach mode). Omit to create a new note.',
        },
        nook_id: {
          type: 'string',
          description: 'Target nook UUID for the new note. Omit to use the current nook.',
        },
      },
    },
  },
];

const handlers: ToolModule['handlers'] = {
  save_image_to_note: async (input, ctx: ToolHandlerContext) => {
    const targetNook =
      typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim()
        : ctx.nookId;
    if (targetNook === '') {
      throw new Error('save_image_to_note: no target nook — the user must have a nook selected');
    }

    const body: Record<string, unknown> = {};
    if (typeof input.title === 'string' && input.title) body.title = input.title;
    if (typeof input.filename === 'string' && input.filename) body.filename = input.filename;
    if (typeof input.note_id === 'string' && input.note_id.trim() !== '') body.note_id = input.note_id.trim();

    // Preferred path: the attachment is already stored at full resolution, so
    // PHP copies the bytes itself. Nothing round-trips through this process and
    // the note can never end up with a downscaled copy.
    const attachmentId = typeof input.attachment_id === 'string' ? input.attachment_id.trim() : '';
    if (attachmentId !== '') {
      body.attachment_id = attachmentId;
      const res = await fetch(
        `${ctx.apiBaseUrl}/api/nooks/${encodeURIComponent(targetNook)}/chat-images/from-attachment`,
        {
          method: 'POST',
          headers: {
            Cookie: ctx.cookie,
            'Content-Type': 'application/json',
            'X-Nook-Actor': 'ai',
          },
          body: JSON.stringify(body),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `API ${res.status} POST /nooks/${targetNook}/chat-images/from-attachment: ${text.slice(0, 800)}`,
        );
      }
      return text;
    }

    // Fallback paths, for when there is no durable attachment (the store was
    // unavailable at paste time). Bytes still never come from the model unless
    // it hands them over explicitly as image_data.
    let base64 = '';
    let mediaType = '';
    if (typeof input.image_index === 'number' && Number.isInteger(input.image_index)) {
      const convId = ctx.conversationId ?? '';
      const img = getTurnImage(convId, input.image_index);
      if (!img) {
        throw new Error(
          `save_image_to_note: no attached image at index ${input.image_index} is available for this turn. `
          + 'Prefer attachment_id (the id from the [IMAGE n] marker) — it stays valid for the whole '
          + 'conversation. If the marker had no id, this image was pasted before the attachment store was '
          + 'reachable, so it cannot be recovered: say the image must be re-attached in a new message, and '
          + 'offer to save it as soon as they do. Do NOT retry the same index and do NOT ask for a refresh.',
        );
      }
      base64 = decodeImage(img.data).toString('base64');
      mediaType = img.media_type ?? '';
    } else if (typeof input.image_data === 'string' && input.image_data.trim() !== '') {
      base64 = input.image_data.trim().replace(/^data:[^,]*,/, '').replace(/\s/g, '');
      mediaType = typeof input.media_type === 'string' ? input.media_type.trim() : '';
    } else {
      throw new Error(
        'save_image_to_note: provide attachment_id (from an [IMAGE n] id=<uuid> marker), '
        + 'image_index (a turn-local fallback), or image_data (base64)',
      );
    }

    body.image_data = base64;
    if (mediaType) body.media_type = mediaType;

    const res = await fetch(`${ctx.apiBaseUrl}/api/nooks/${encodeURIComponent(targetNook)}/chat-images`, {
      method: 'POST',
      headers: {
        Cookie: ctx.cookie,
        'Content-Type': 'application/json',
        'X-Nook-Actor': 'ai',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status} POST /nooks/${targetNook}/chat-images: ${text.slice(0, 800)}`);
    }
    return text;
  },
};

export const imageSaveTools: ToolModule = {
  name: 'image-save',
  // Always available — saving a user's image doesn't depend on any
  // optional provider. Gated on a nook being present at call time (the
  // handler errors cleanly if not).
  enabled: () => true,
  definitions,
  handlers,
  // A write that mutates the user's notes — requires approval.
  // Intentionally NOT in autoApproved.
};
