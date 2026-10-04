/**
 * Client for the chat-attachment store (PHP side: ChatAttachmentsController).
 *
 * An attachment is the ORIGINAL full-resolution bytes of an image the user
 * pasted into a chat message, kept on disk with a row in
 * global.conversation_images for the life of the conversation.
 *
 * Why this replaced the in-memory per-turn stash: the bytes used to live in a
 * Map inside this process and were dropped the moment the turn ended, which
 * made "analyse this image now, save it as a note in a minute" impossible and
 * left the model unable to look at the picture again. With a durable id the
 * attachment survives the turn, the request, and the process.
 */

export type StoredAttachment = {
  /** Durable uuid — what the model passes to look_at_image / save_image_to_note. */
  id: string;
  /** Append-only, conversation-scoped [IMAGE n]. Never reused or renumbered. */
  attachment_index: number;
  filename: string;
  media_type: string;
  filesize: number;
};

export type AttachmentBytes = {
  buffer: Buffer;
  mediaType: string;
  filename: string;
};

/** One image as the browser sent it: base64 (bare or data: URI) + mime. */
export type IncomingAttachment = {
  data: string;
  media_type?: string;
  filename?: string;
};

/**
 * Persist this turn's attachments. Returns one row per stored image.
 *
 * Throws on failure — callers decide whether that's fatal (see chat.ts: a
 * failed upload degrades to the in-memory turn stash rather than losing the
 * turn entirely).
 */
export async function storeAttachments(
  conversationId: string,
  images: IncomingAttachment[],
  opts: { turnId?: string; nookId?: string; apiBase: string; cookie: string },
): Promise<StoredAttachment[]> {
  const res = await fetch(`${opts.apiBase}/api/conversations/${encodeURIComponent(conversationId)}/images`, {
    method: 'POST',
    headers: {
      Cookie: opts.cookie,
      'Content-Type': 'application/json',
      'X-Nook-Actor': 'ai',
    },
    body: JSON.stringify({
      images: images.map((img) => ({
        data: img.data,
        ...(img.media_type ? { media_type: img.media_type } : {}),
        ...(img.filename ? { filename: img.filename } : {}),
      })),
      ...(opts.turnId ? { turn_id: opts.turnId } : {}),
      ...(opts.nookId ? { nook_id: opts.nookId } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status} POST /conversations/${conversationId}/images: ${text.slice(0, 800)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`API POST /conversations/${conversationId}/images returned non-JSON: ${text.slice(0, 200)}`);
  }
  const rows = (parsed as { images?: unknown }).images;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isStoredAttachment);
}

/**
 * Read an attachment's ORIGINAL bytes back. Used by look_at_image to re-inject
 * the picture into a later turn, and as the fallback path for saving.
 */
export async function fetchAttachmentBytes(
  conversationId: string,
  imageId: string,
  opts: { apiBase: string; cookie: string },
): Promise<AttachmentBytes> {
  const res = await fetch(
    `${opts.apiBase}/api/conversations/${encodeURIComponent(conversationId)}/images/${encodeURIComponent(imageId)}`,
    { headers: { Cookie: opts.cookie } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `API ${res.status} GET /conversations/${conversationId}/images/${imageId}: ${text.slice(0, 400)}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  // The API echoes the stored mime type in a header; fall back to a sniff so a
  // proxy that drops custom headers still yields a usable media type.
  const headerType = res.headers.get('x-image-mime') ?? res.headers.get('content-type') ?? '';
  const mediaType = normalizeImageMediaType(headerType) ?? sniffImageMediaType(buffer) ?? 'image/png';
  const filename = res.headers.get('x-image-filename') ?? '';
  return { buffer, mediaType, filename };
}

/**
 * Read the current image attached to a NOTE (an upload, an AI-generated image,
 * or a chat attachment that was copied into a note). This is how the model gets
 * to see a picture that already lives in the user's notes — get_note only ever
 * returns its metadata.
 */
export async function fetchNoteImageBytes(
  nookId: string,
  noteId: string,
  opts: { apiBase: string; cookie: string },
): Promise<AttachmentBytes> {
  const res = await fetch(
    `${opts.apiBase}/api/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/image`,
    { headers: { Cookie: opts.cookie } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} GET /nooks/${nookId}/notes/${noteId}/image: ${text.slice(0, 400)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const headerType = res.headers.get('x-image-mime') ?? res.headers.get('content-type') ?? '';
  const mediaType = normalizeImageMediaType(headerType) ?? sniffImageMediaType(buffer) ?? 'image/png';
  const filename = res.headers.get('x-image-filename') ?? '';
  return { buffer, mediaType, filename };
}

/** Strip parameters from a content-type and keep only what sharp can encode. */
export function normalizeImageMediaType(raw: string): string | null {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/png' || base === 'image/jpeg' || base === 'image/jpg' || base === 'image/webp') {
    return base === 'image/jpg' ? 'image/jpeg' : base;
  }
  return null;
}

/** Magic-number fallback so a missing header can't produce an undecodable block. */
export function sniffImageMediaType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function isStoredAttachment(row: unknown): row is StoredAttachment {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.id === 'string' && r.id !== '' && typeof r.attachment_index === 'number';
}