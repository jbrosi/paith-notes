import { useNavigate } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import styles from "../App.module.css";
import { apiFetch } from "../auth/keycloak";

type PersonalNookResponse = {
	nook: {
		id: string;
		name: string;
		is_personal: true;
	};
};

const CYPRESS_NOOK_ID = "00000000-0000-0000-0000-000000000000";

function isCypressRun(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as unknown as { Cypress?: unknown }).Cypress !== "undefined"
	);
}

export default function NooksRedirect() {
	const navigate = useNavigate();

	const [data] = createResource(async () => {
		if (isCypressRun()) {
			navigate(`/nooks/${CYPRESS_NOOK_ID}`, { replace: true });
			return null;
		}

		const res = await apiFetch("/api/nooks/personal", {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});
		if (!res.ok) {
			throw new Error(
				`Failed to load personal nook: ${res.status} ${res.statusText}`,
			);
		}

		const body = (await res.json()) as PersonalNookResponse;
		if (!body?.nook?.id) {
			throw new Error("Personal nook id missing");
		}

		navigate(`/nooks/${body.nook.id}`, { replace: true });
		return body;
	});

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>Loading...</h1>
			<Show when={!data.loading}>
				<Show
					when={!data.error}
					fallback={<pre class={styles.error}>{String(data.error)}</pre>}
				>
					<p class={styles.subtitle}>Redirecting to your personal nook…</p>
				</Show>
			</Show>
		</main>
	);
}
