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
			if (!res.ok) {
				console.warn(
					`[features] /api/me returned ${res.status}; voice stays disabled`,
				);
				return;
			}
			const body = (await res.json()) as { features?: Partial<Features> };
			const next = { voice: body.features?.voice === true };
			console.log(
				"[features] loaded:",
				next,
				"(raw features payload:",
				body.features,
				")",
			);
			setFeatures(next);
		} catch (e) {
			console.warn("[features] /api/me fetch failed:", e);
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
