import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";
import { isAuthenticated, login, logout, logoutSso } from "./keycloak";

export type AuthState = {
	ready: () => boolean;
	authenticated: () => boolean;
	error: () => string;
	login: (redirectTo?: string) => void;
	logout: () => void;
	logoutSso: () => void;
};

const AuthContext = createContext<AuthState>();

export function AuthProvider(props: { children: JSX.Element }) {
	const [ready, setReady] = createSignal(false);
	const [authenticated, setAuthenticated] = createSignal(false);
	const [error, setError] = createSignal("");

	onMount(() => {
		(async () => {
			try {
				const ok = await isAuthenticated();
				setAuthenticated(ok);
			} catch (e) {
				setError(String(e));
				setAuthenticated(false);
			} finally {
				setReady(true);
			}
		})();
	});

	const state: AuthState = {
		ready,
		authenticated,
		error,
		login: (redirectTo?: string) => {
			try {
				login(redirectTo);
			} catch (e) {
				setError(String(e));
			}
		},
		logout: () => {
			logout().catch((e) => setError(String(e)));
		},
		logoutSso: () => {
			logoutSso().catch((e) => setError(String(e)));
		},
	};

	return (
		<AuthContext.Provider value={state}>{props.children}</AuthContext.Provider>
	);
}

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) {
		throw new Error("AuthProvider is missing");
	}
	return ctx;
}
