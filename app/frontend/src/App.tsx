import { createResource, Show } from "solid-js";
import Button from "./components/Button";
import styles from "./App.module.css";

type HealthResponse = {
	status: string;
	service: string;
	ts: string;
	counter: number;
};

const fetchHealth = async (): Promise<HealthResponse> => {
	const res = await fetch("/health", {
		headers: {
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		throw new Error(`Health request failed: ${res.status} ${res.statusText}`);
	}

	return res.json() as Promise<HealthResponse>;
};

export default function App() {
	const [health, { refetch }] = createResource<HealthResponse>(fetchHealth);

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>Paith Notes</h1>
			<p class={styles.subtitle}>
				Dev UI (SolidJS) fetching <code>/health</code>
			</p>

			<Show when={!health.loading} fallback={<p>Loading health...</p>}>
				<Show
					when={!health.error}
					fallback={<pre class={styles.error}>{String(health.error)}</pre>}
				>
					<pre class={styles.pre}>{JSON.stringify(health(), null, 2)}</pre>
				</Show>
			</Show>

			<Button onClick={() => refetch()}>Refetch</Button>
		</main>
	);
}
