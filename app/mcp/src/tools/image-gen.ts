import type { ToolModule } from './types.js';

// Image generation (OpenAI gpt-image-1). Posts to the PHP backend
// /api/nooks/<nook>/ai-images which proxies to OpenAI and stores the
// result as a generated_image note. Gated on OPENAI_API_KEY because
// without it the backend stubs the call (returns a 1x1 PNG) — better
// to hide the tool entirely than to have the LLM offer image
// generation that silently no-ops.

const ENABLED = (process.env.OPENAI_API_KEY ?? '').trim() !== '';

const definitions: ToolModule['definitions'] = [
  {
    name: 'generate_image',
    description:
      "Generate an image from a text prompt and store it as a generated_image note in the user's AI memory nook (default) or a specific nook. Costs real money per call — the user is asked to approve. Returns the new note's id, the model's revised_prompt, and the call's usage/cost.\n\n## How to write the prompt (most important)\n\nThe single biggest factor in image quality is prompt richness. Write like an art director, not a tag list. A good prompt is typically 60–200 words and covers: SUBJECT (what + who + doing what), COMPOSITION (camera angle, framing, foreground/midground/background), LIGHTING (time of day, source, mood — \"soft golden hour rim light from camera-left\"), STYLE/MEDIUM (\"watercolor on rough paper\", \"35mm film photograph\", \"flat vector illustration\"), MATERIALS/TEXTURES, COLOR PALETTE, and MOOD. Be specific: \"a fox\" produces a generic stock fox; \"a young red fox curled in the snow at dusk, breath visible, eyes half-closed, dim violet sky, faint pine silhouette behind\" produces something with intent. If the user gave a terse request, EXPAND it into a rich prompt yourself — don't pass their two-word brief through verbatim. The model's revised_prompt response shows what it actually drew; if it doesn't match the user's intent, the prompt was too vague.\n\n## Refinement vs new note\n\nWhen the user says something like \"make it darker\" or \"the same one but with a sunset\" they're refining the LAST image you generated in this chat — pass that note id as refine_note_id so we update the existing note, bump the file version, and append the new summary to its body. When the user says something like \"for the birthday party, the invitation needs...\" referring to an older image, FIRST use memory_search to find the matching prior generated_image note, then refine that one. When in doubt about which note to refine, use ask_user to confirm — never silently guess between candidates.\n\nFor a brand-new topic (no prior image referenced), omit refine_note_id and a fresh note is created.\n\nRefinement automatically feeds the prior image back to the model as input, so \"make it darker\" actually edits the existing image instead of regenerating from scratch with a tweaked prompt — this is what makes iteration feel coherent. You don't need to do anything special; just pass refine_note_id and a focused prompt describing the CHANGE (\"shift palette to dusk tones, add long shadows from the left\"), not a re-description of the whole image. If the user wants a clean restart from text only (e.g. \"the composition is wrong, try totally different\"), pass source_note_ids: [] explicitly to opt out of the edit anchor.\n\n## Image-to-image with user-provided sources\n\nFor \"enhance this drawing\", \"clean up this photo\", \"use this as a reference\" — pass source_note_ids referencing any image-bearing note(s) the user wants used as input. CRITICAL: source_note_ids and refine_note_id are DIFFERENT — refine_note_id is the OUTPUT note to update; source_note_ids are the INPUT images that stay frozen as the anchor across iterations. NEVER set source_note_ids to a generated_image you just produced as a way of \"continuing from\" it — that's automatic via refine_note_id. On refinement of a source-anchored generation, source_note_ids auto-inherits the original input so the user's drawing stays the anchor across iterations.\n\n## Quality\n\nDefault is \"low\" — fast and cheap (~$0.01–0.02), great for prompt iteration. Escalate to medium (~$0.04–0.06) for serious iteration the user wants to refine further, or high (~$0.17–0.25) when they explicitly ask for a finished/printable image. On a refinement, omitted size/quality/transparent inherit from the prior note.\n\n## Summary (required)\n\nWrite a short (1–2 sentence) human-readable description of what this iteration is about; it seeds the note body and, on refinements, gets appended as a versioned changelog so the user has a chronological narrative of how the image evolved.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            "What to generate, written like an art director (60–200 words). Cover subject, composition (angle/framing), lighting (source/time/mood), style/medium, materials, color palette. Don't just relay the user's terse brief verbatim — EXPAND it. On a refinement, write only the CHANGE you want (\"shift palette to dusk\", not a re-description of the whole image), since the prior image is fed back as the anchor.",
        },
        summary: {
          type: 'string',
          description:
            'A 1–2 sentence human-readable description of this iteration ("first take of the birthday invitation in pastels" / "swapped the pink for lavender per user request"). Seeds the note body; on refinements becomes a versioned changelog entry.',
        },
        nook_id: {
          type: 'string',
          description: 'Target nook UUID. Omit to drop the image in ai-memory (the default and recommended behaviour).',
        },
        refine_note_id: {
          type: 'string',
          description:
            "UUID of an existing generated_image note to refine. When provided, the existing note is updated (file_version bumped, attributes overwritten, summary appended) instead of creating a new note. The note must be a generated_image in the same target nook. The prior image is automatically fed back to the model as input so refinement is an edit, not a regenerate — write the prompt as the CHANGE, not a re-description. Inherit-default: omitted size/quality/transparent reuse the prior note's values; source_note_ids auto-inherits any original user-provided source anchors.",
        },
        source_note_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional list of UUIDs identifying any image-bearing notes (uploads, attachments, prior generated_images) to feed as INPUT to the model — image-to-image edit instead of pure text-to-image. Use when the user says \"enhance this drawing\", \"clean up this photo\", \"use this as a reference\", etc. Cap is 4 sources. DO NOT use this to chain off your own last output — that's what refine_note_id is for. On refinement, omit this and the original user source (if any) auto-inherits + the prior output is auto-fed as the edit anchor. Pass explicit [] to opt out of the auto edit-anchor and force a clean text-to-image regenerate (use when the user wants a fundamentally different composition).",
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
          description:
            "Output dimensions. New-note default: 1024x1024. Refinement: inherits prior note's size when omitted.",
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'auto'],
          description:
            "Rendering quality. New-note default: \"low\". Refinement: inherits prior note's quality when omitted. low ~$0.01–0.02, medium ~$0.04–0.06, high ~$0.17–0.25 (~4–6× the cost). Escalate only when the user explicitly asks for a finished/printable image.",
        },
        transparent: {
          type: 'boolean',
          description:
            'Generate with a transparent background (PNG with alpha). New-note default: false. Refinement: inherits prior value when omitted.',
        },
      },
      required: ['prompt', 'summary'],
    },
  },
];

const handlers: ToolModule['handlers'] = {
  generate_image: async (input, ctx) => {
    // Sentinel "ai-memory" is resolved server-side; pass it through
    // whenever the caller doesn't specify a nook so we don't have to
    // round-trip GET /nooks/ai-memory from here.
    const target =
      typeof input.nook_id === 'string' && input.nook_id.trim() !== ''
        ? input.nook_id.trim()
        : 'ai-memory';
    const body: Record<string, unknown> = { prompt: String(input.prompt ?? '') };
    if (input.summary) body.summary = String(input.summary);
    if (input.refine_note_id) body.refine_note_id = String(input.refine_note_id);
    if (input.size) body.size = String(input.size);
    if (input.quality) body.quality = String(input.quality);
    if (input.transparent) body.transparent = true;
    if (Array.isArray(input.source_note_ids)) {
      // Pass through verbatim — server validates UUID shape + cap.
      body.source_note_ids = input.source_note_ids.map((v) => String(v));
    }

    const res = await fetch(`${ctx.apiBaseUrl}/api/nooks/${target}/ai-images`, {
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
      throw new Error(`API ${res.status} POST /api/nooks/${target}/ai-images: ${text.slice(0, 800)}`);
    }
    return text;
  },
};

export const imageGenTools: ToolModule = {
  name: 'image-gen',
  enabled: () => ENABLED,
  definitions,
  handlers,
  // Costs real money — always require explicit user approval.
  // (Intentionally NOT in autoApproved.)
};
