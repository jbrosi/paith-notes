/**
 * Which models can accept image input.
 *
 * Deliberately a leaf module: tools (image-view.ts) need this at call time, and
 * importing it from chat.ts would create an import cycle
 * registry → tool module → chat → registry that blows up at module init.
 *
 * paith-low is a 9B text-only fine-tune (its Ollama build has no mmproj vision
 * projection, so the backend rejects image blocks with a 500). paith-high is the
 * 27B VL build and sees images. Everything else degrades to "the model can't
 * see images, tell the user to switch to Paith High".
 */
const VISION_MODELS = new Set(["paith-high"]);

export function modelSupportsVision(model: string): boolean {
	return VISION_MODELS.has(model);
}
