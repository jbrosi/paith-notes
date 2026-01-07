import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";
import { initKeycloak, keycloak } from "./keycloak";

export type AuthState = {
	ready: () => boolean;
	authenticated: () => boolean;
	error: () => string;
	login: (redirectTo?: string) => void;
	logout: () => void;
	token: () => string;
};

const AuthContext = createContext<AuthState>();

export function AuthProvider(props: { children: JSX.Element }) {
	const [ready, setReady] = createSignal(false);
	const [authenticated, setAuthenticated] = createSignal(false);
	const [error, setError] = createSignal("");

	onMount(() => {
		(async () => {
			try {
				const ok = await initKeycloak();
				setAuthenticated(ok);

				keycloak.onAuthSuccess = () => setAuthenticated(true);
				keycloak.onAuthLogout = () => setAuthenticated(false);
				keycloak.onTokenExpired = () => {
					keycloak.updateToken(30).catch(() => setAuthenticated(false));
				};
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
			keycloak
				.login({
					redirectUri: redirectTo
						? `${window.location.origin}${redirectTo}`
						: window.location.href,
				})
				.catch((e) => setError(String(e)));
		},
		logout: () => {
			keycloak
				.logout({ redirectUri: window.location.origin })
				.catch((e) => setError(String(e)))
				.finally(() => {
					window.location.href = "/";
				});
		},
		token: () => keycloak.token ?? "",
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
