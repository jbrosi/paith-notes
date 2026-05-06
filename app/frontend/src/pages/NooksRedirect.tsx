import { useNavigate } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import styles from "../App.module.css";
import { apiFetch, login } from "../auth/keycloak";

export default function NooksRedirect() {
	const navigate = useNavigate();

	const [data] = createResource(async () => {
		const res = await apiFetch("/api/nooks", { method: "GET" });
		if (res.status === 401) {
			return { id: "" };
		}
		if (!res.ok) {
			throw new Error(`Failed to load nooks: ${res.status} ${res.statusText}`);
		}

		const body = (await res.json()) as { nooks?: unknown[] };
		const list = Array.isArray(body?.nooks) ? body.nooks : [];
		const first = list[0];
		if (first && typeof first === "object" && "id" in first) {
			const id = String((first as Record<string, unknown>).id ?? "");
			if (id) {
				navigate(`/nooks/${id}`, { replace: true });
				return { id };
			}
		}

		throw new Error("No nooks found");
	});

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>Loading...</h1>
			<Show when={!data.loading}>
				<Show
					when={!data.error}
					fallback={<pre class={styles.error}>{String(data.error)}</pre>}
				>
					<Show
						when={Boolean(data()?.id)}
						fallback={
							<div>
								<p class={styles.subtitle}>
									Your session timed out. Please log in again.
								</p>
								<button type="button" onClick={() => login()}>
									Log in
								</button>
							</div>
						}
					>
						<p class={styles.subtitle}>Redirecting to your nook…</p>
					</Show>
				</Show>
			</Show>
		</main>
	);
}
