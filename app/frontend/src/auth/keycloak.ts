import Keycloak from "keycloak-js";

const keycloakUrl = String(import.meta.env.VITE_KEYCLOAK_URL ?? "").trim();
const keycloakRealm = String(import.meta.env.VITE_KEYCLOAK_REALM ?? "").trim();
const keycloakClientId = String(
	import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "",
).trim();

const keycloakInitTimeoutMs = Number(
	import.meta.env.VITE_KEYCLOAK_INIT_TIMEOUT_MS ?? 8000,
);

type KeycloakLike = {
	authenticated?: boolean;
	token?: string;
	onAuthSuccess?: () => void;
	onAuthLogout?: () => void;
	onTokenExpired?: () => void;
	init: (
		options: Parameters<Keycloak["init"]>[0],
	) => ReturnType<Keycloak["init"]>;
	login: (
		options: Parameters<Keycloak["login"]>[0],
	) => ReturnType<Keycloak["login"]>;
	logout: (
		options: Parameters<Keycloak["logout"]>[0],
	) => ReturnType<Keycloak["logout"]>;
	updateToken: (
		minValidity: Parameters<Keycloak["updateToken"]>[0],
	) => ReturnType<Keycloak["updateToken"]>;
};

function isCypressRun(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as unknown as { Cypress?: unknown }).Cypress !== "undefined"
	);
}

function createCypressKeycloakStub(): KeycloakLike {
	return {
		authenticated: true,
		token: "cypress",
		init: async () => true,
		login: async () => {
			// no-op for e2e
		},
		logout: async () => {
			// no-op for e2e
		},
		updateToken: async () => true,
	};
}

function createDevHeaderAuthStub(): KeycloakLike {
	return {
		authenticated: true,
		token: "dev",
		init: async () => true,
		login: async () => {
			// no-op for dev
		},
		logout: async () => {
			// no-op for dev
		},
		updateToken: async () => true,
	};
}

function createMissingConfigKeycloakStub(): KeycloakLike {
	const error = new Error(
		"Keycloak is not configured. Set VITE_KEYCLOAK_URL, VITE_KEYCLOAK_REALM, and VITE_KEYCLOAK_CLIENT_ID (or, when using docker-compose, set KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID and restart the frontend container).",
	);

	return {
		authenticated: false,
		token: "",
		init: async () => false,
		login: async () => {
			throw error;
		},
		logout: async () => {
			// no-op
		},
		updateToken: async () => {
			throw error;
		},
	};
}

export const keycloak: KeycloakLike = isCypressRun()
	? createCypressKeycloakStub()
	: keycloakUrl === "" || keycloakRealm === "" || keycloakClientId === ""
		? import.meta.env.DEV
			? createDevHeaderAuthStub()
			: createMissingConfigKeycloakStub()
		: new Keycloak({
				url: keycloakUrl,
				realm: keycloakRealm,
				clientId: keycloakClientId,
			});

export async function initKeycloak(): Promise<boolean> {
	const initPromise = keycloak.init({
		onLoad: "check-sso",
		pkceMethod: "S256",
		checkLoginIframe: false,
	});

	const timeoutMs =
		Number.isFinite(keycloakInitTimeoutMs) && keycloakInitTimeoutMs > 0
			? keycloakInitTimeoutMs
			: 8000;

	const timeoutPromise = new Promise<boolean>((_, reject) => {
		setTimeout(() => {
			reject(new Error(`Keycloak init timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	return Promise.race([initPromise, timeoutPromise]);
}

export async function ensureFreshToken(
	minValiditySeconds = 30,
): Promise<string> {
	if (!keycloak.authenticated) {
		throw new Error("not authenticated");
	}

	await keycloak.updateToken(minValiditySeconds);
	const token = keycloak.token;
	if (!token) {
		throw new Error("missing token");
	}
	return token;
}

export async function apiFetch(
	input: RequestInfo | URL,
	init: RequestInit = {},
): Promise<Response> {
	const token = await ensureFreshToken(30);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);

	if (token === "dev" || token === "cypress") {
		if (!headers.has("X-Nook-User")) {
			headers.set("X-Nook-User", "11111111-1111-4111-8111-111111111111");
		}
		if (!headers.has("X-Nook-Groups")) {
			headers.set("X-Nook-Groups", "paith/notes");
		}
	}

	if (!headers.has("Accept")) {
		headers.set("Accept", "application/json");
	}

	return fetch(input, {
		...init,
		headers,
	});
}
