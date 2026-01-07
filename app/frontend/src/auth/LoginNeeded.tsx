import styles from "../App.module.css";
import { Button } from "../components/Button";
import { useAuth } from "./AuthContext";

export function LoginNeeded(props: { redirectTo?: string }) {
	const auth = useAuth();

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>Login needed</h1>
			<p class={styles.subtitle}>
				Most parts of this app require you to sign in.
			</p>

			{auth.error() !== "" ? (
				<pre class={styles.error}>{auth.error()}</pre>
			) : null}

			<Button onClick={() => auth.login(props.redirectTo)}>Login</Button>
		</main>
	);
}
