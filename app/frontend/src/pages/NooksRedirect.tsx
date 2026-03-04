import { useNavigate } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import styles from "../App.module.css";
import { apiFetch, login } from "../auth/keycloak";

type PersonalNookResponse = {
	nook: {
		id: string;
		name: string;
		is_personal: true;
	};
};

export default function NooksRedirect() {
	const navigate = useNavigate();

	const [data] = createResource(async () => {
		const res = await apiFetch("/api/nooks/personal", {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});
		if (res.status === 401) {
			return {
				nook: { id: "", name: "", is_personal: true },
			} as PersonalNookResponse;
		}
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
					<Show
						when={Boolean(data()?.nook?.id)}
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
						<p class={styles.subtitle}>Redirecting to your personal nook…</p>
					</Show>
				</Show>
			</Show>
		</main>
	);
}
