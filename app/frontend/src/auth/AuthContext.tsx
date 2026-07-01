import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";
import { loadFeatures } from "../features";
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
				// Load server-reported feature flags here (not in RequireAuth)
				// so consumers outside any RequireAuth wrapper — most notably
				// the always-mounted ChatPanel in App.tsx — also see the
				// up-to-date features signal. Fires exactly once per session
				// thanks to the inflight guard in loadFeatures().
				if (ok) void loadFeatures();
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
