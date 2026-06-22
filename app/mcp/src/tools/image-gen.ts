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
      "Generate an image from a text prompt and store it as a generated_image note in the user's AI memory nook (default) or a specific nook. Costs real money per call — the user is asked to approve. Returns the new note's id, the model's revised_prompt, and the call's usage/cost.\n\nRefinement vs new note: when the user says something like \"make it darker\" or \"the same one but with a sunset\" they're refining the LAST image you generated in this chat — pass that note id as refine_note_id so we update the existing note, bump the file version, and append the new summary to its body. When the user says something like \"for the birthday party, the invitation needs...\" referring to an older image, FIRST use memory_search to find the matching prior generated_image note, then refine that one. When in doubt about which note to refine, use ask_user to confirm — never silently guess between candidates.\n\nFor a brand-new topic (no prior image referenced), omit refine_note_id and a fresh note is created.\n\nDefault quality is \"low\" — fast and cheap (~$0.01–0.02), great for prompt iteration. Only escalate to medium (~$0.04–0.06) or high (~$0.17–0.25) when the user explicitly asks for a finished/printable image. On a refinement, omitted size/quality/transparent inherit from the prior note.\n\nThe summary field is required: write a short (1–2 sentence) human-readable description of what this iteration is about; it seeds the note body and, on refinements, gets appended as a versioned changelog so the user has a chronological narrative of how the image evolved.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            "What to generate. Be specific — the provider rewrites short prompts and you'll get a revised_prompt back showing what it actually drew.",
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
            "UUID of an existing generated_image note to refine. When provided, the existing note is updated (file_version bumped, attributes overwritten, summary appended) instead of creating a new note. The note must be a generated_image in the same target nook. Inherit-default: any of size/quality/transparent you omit will reuse the prior note's values.",
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
