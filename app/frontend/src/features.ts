import { createSignal } from "solid-js";
import { apiFetch } from "./auth/keycloak";

type Features = { voice: boolean };

const [features, setFeatures] = createSignal<Features>({ voice: false });
let inflight: Promise<void> | null = null;

export function useFeatures() {
	return features;
}

export async function loadFeatures(): Promise<void> {
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const res = await apiFetch("/api/me", { method: "GET" });
			if (!res.ok) return;
			const body = (await res.json()) as { features?: Partial<Features> };
			setFeatures({ voice: body.features?.voice === true });
		} catch {
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
