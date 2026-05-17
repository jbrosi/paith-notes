import { createContext, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js";
import { onSessionExpired } from "./keycloak";

type ApiContext = {
	sessionExpired: () => boolean;
};

const ApiCtx = createContext<ApiContext>();

const HEARTBEAT_INTERVAL = 3 * 60 * 1000; // 3 minutes

export function ApiProvider(props: { children: JSX.Element }) {
	const [sessionExpired, setSessionExpired] = createSignal(false);

	// Listen to global 401 events from apiFetch
	onMount(() => {
		const unsubscribe = onSessionExpired(() => setSessionExpired(true));
		onCleanup(unsubscribe);
	});

	// Background heartbeat for idle detection
	onMount(() => {
		const check = async () => {
			try {
				const res = await fetch("/api/auth/check", {
					method: "GET",
					credentials: "include",
				});
				if (!res.ok) setSessionExpired(true);
			} catch {
				// network error — don't mark expired, might be offline
			}
		};

		const interval = setInterval(check, HEARTBEAT_INTERVAL);
		onCleanup(() => clearInterval(interval));
	});

	return <ApiCtx.Provider value={{ sessionExpired }}>{props.children}</ApiCtx.Provider>;
}

export function useApi(): ApiContext {
	const ctx = useContext(ApiCtx);
	if (!ctx) {
		throw new Error("useApi must be used within ApiProvider");
	}
	return ctx;
}
