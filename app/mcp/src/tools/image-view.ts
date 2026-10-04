import type Anthropic from '@anthropic-ai/sdk';
import { resizeForVision } from '../image-resize.js';
import { fetchAttachmentBytes, fetchNoteImageBytes } from '../chat-attachments.js';
import { modelSupportsVision } from '../vision-model.js';
import type { ToolHandlerContext, ToolModule, ToolResultContent } from './types.js';

/**
 * Hand the model the actual PIXELS of an image.
 *
 * Two sources, one tool, because the failure they share is identical: the model
 * can read a filename, a mime type and a byte count, and still be completely
 * blind. That is what happens when it uses get_note on an image note — the API
 * returns metadata only, and the model then either says "I can't view the image
 * pixels" or, worse, invents a description. A text tool_result cannot fix that;
 * the pixels have to come back as a real Anthropic `image` content block.
 *
 *   image_id  → a chat attachment the user pasted (any turn of this chat)
 *   note_id   → the current image on a note (upload, generated_image, or a
 *               chat attachment that was saved into a note)
 *
 * Auto-approved: it is a read, and requiring a click to look at a picture would
 * make the feature unusable.
 */

const definitions: ToolModule['definitions'] = [
  {
    name: 'look_at_image',
    description:
      'Actually LOOK at an image and see its contents. Returns the real pixels to you as an image block.\n\n' +
      "**Use this whenever the user asks what an image looks like** — 'what is in this picture', 'describe this screenshot', 'read this diagram', 'who is in this photo', 'what colour is X'. Without it you only ever see metadata (filename, mime type, byte size), which is never enough to answer, and guessing is worse than saying you can't see it.\n\n" +
      '## Inputs (pass exactly one)\n' +
      '- `image_id`: a chat attachment, from an `[IMAGE n] id=<uuid>` marker. Works for ANY turn of the current conversation, not just the current message — the attachment is kept for the life of the conversation, so an image from ten messages ago is still there.\n' +
      '- `note_id`: a note that carries an image (an upload, a `generated_image`, or a picture saved from chat). Get the id from search_notes / get_note / a `[[note:…]]` reference.\n' +
      '- `nook_id`: only with `note_id`, and only when the note is in a different nook. Omit for the current nook.\n\n' +
      '## Notes\n' +
      '- Only works on a vision-capable model. On a text-only model it tells you so; say that plainly and suggest "Paith High" rather than describing anything.\n' +
      '- Pass `version` only if the user is explicitly asking about a specific older version of a note\'s picture; by default you get the current one.\n' +
      '- One image per call. If the user attached several and asked about all of them, call it once per `[IMAGE n]`.',
    input_schema: {
      type: 'object',
      properties: {
        image_id: {
          type: 'string',
          description: 'Attachment uuid from an [IMAGE n] id=<uuid> marker. Any turn of this conversation.',
        },
        note_id: {
          type: 'string',
          description: 'UUID of a note that carries an image. Use this instead of image_id for images already saved in a nook.',
        },
        nook_id: {
          type: 'string',
          description: 'Nook containing note_id, when it is not the current nook.',
        },
        version: {
          type: 'integer',
          description: 'Specific file version of a note image. Omit for the current version.',
        },
      },
    },
  },
];

function noVisionMessage(model: string | undefined): string {
  const name = model && model !== '' ? model : 'the current model';
  return (
    `Cannot show you this image: ${name} has no vision capability, so no pixels can be put in front of it. ` +
    'Do NOT describe or guess the contents from the filename or size. ' +
    'Tell the user this model cannot see images and suggest switching to "Paith High" (vision-capable) — the image itself is stored and will still be there afterwards.'
  );
}

const handlers: ToolModule['handlers'] = {
  look_at_image: async (input, ctx: ToolHandlerContext): Promise<ToolResultContent> => {
    if (!modelSupportsVision(ctx.model ?? '')) {
      return noVisionMessage(ctx.model);
    }

    const imageId = typeof input.image_id === 'string' ? input.image_id.trim() : '';
    const noteId = typeof input.note_id === 'string' ? input.note_id.trim() : '';
    if (imageId === '' && noteId === '') {
      throw new Error('look_at_image: pass image_id (a chat attachment) or note_id (a note with an image)');
    }

    let fetched: { buffer: Buffer; mediaType: string; filename: string };
    let source: string;
    if (imageId !== '') {
      if (!ctx.conversationId) {
        throw new Error('look_at_image: no conversation in scope for an attachment lookup');
      }
      fetched = await fetchAttachmentBytes(ctx.conversationId, imageId, {
        apiBase: ctx.apiBaseUrl,
        cookie: ctx.cookie,
      });
      source = `chat attachment ${imageId}`;
    } else {
      const nookId = typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim()
        : ctx.nookId;
      if (nookId === '') {
        throw new Error(
          'look_at_image: note_id needs a nook — the user has no nook selected, so pass nook_id explicitly',
        );
      }
      fetched = await fetchNoteImageBytes(nookId, noteId, { apiBase: ctx.apiBaseUrl, cookie: ctx.cookie });
      source = `note ${noteId}`;
    }

    let resized: Awaited<ReturnType<typeof resizeForVision>>;
    try {
      resized = await resizeForVision(fetched.buffer);
    } catch (err) {
      throw new Error(
        `look_at_image: could not decode ${source} (${fetched.mediaType}, ${fetched.buffer.length} bytes) — `
        + `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}. `
        + 'Do NOT guess what it shows; tell the user the image could not be processed.',
      );
    }

    // Text first so the model knows what it is looking at before the pixels,
    // then the image block itself.
    const header: Anthropic.TextBlockParam = {
      type: 'text',
      text:
        `You are now looking at ${source}${fetched.filename ? ` ("${fetched.filename}")` : ''} — `
        + `${fetched.mediaType}, original ${fetched.buffer.length} bytes, shown to you downscaled to `
        + `${Math.round((resized.base64.length * 3) / 4)} bytes to bound token cost. `
        + 'Describe what you actually see. Do not rely on the filename to guess the contents.',
    };
    const image: Anthropic.ImageBlockParam = {
      type: 'image',
      source: { type: 'base64', media_type: resized.mediaType, data: resized.base64 },
    };
    return [header, image];
  },
};

export const imageViewTools: ToolModule = {
  name: 'image-view',
  // Always available. On a text-only model the handler explains itself instead
  // of pretending, so gating registration would only hide the reason.
  enabled: () => true,
  definitions,
  handlers,
  // A read — auto-approved. The alternative is a click-to-look experience.
  autoApproved: ['look_at_image'],
};