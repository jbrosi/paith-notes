import { createEffect, type JSX, Show } from "solid-js";
import styles from "../App.module.css";
import { loadFeatures } from "../features";
import { useAuth } from "./AuthContext";
import { LoginNeeded } from "./LoginNeeded";

export function RequireAuth(props: {
	children: JSX.Element;
	redirectTo?: string;
}) {
	const auth = useAuth();

	createEffect(() => {
		if (auth.ready() && auth.authenticated()) void loadFeatures();
	});

	const redirectTo = () =>
		props.redirectTo?.trim()
			? props.redirectTo.trim()
			: `${window.location.pathname}${window.location.search}${window.location.hash}`;

	return (
		<Show
			when={auth.ready()}
			fallback={
				<main class={styles.container}>
					<h1 class={styles.title}>Signing in…</h1>
					<div class={styles["loading-row"]}>
						<div class={styles.spinner} />
						<p class={styles.subtitle}>Checking login state…</p>
					</div>
				</main>
			}
		>
			<Show
				when={auth.authenticated()}
				fallback={<LoginNeeded redirectTo={redirectTo()} />}
			>
				{props.children}
			</Show>
		</Show>
	);
}
