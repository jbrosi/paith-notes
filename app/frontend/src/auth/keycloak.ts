import Keycloak from "keycloak-js";

const keycloakUrl = String(import.meta.env.VITE_KEYCLOAK_URL ?? "").trim();
const keycloakRealm = String(import.meta.env.VITE_KEYCLOAK_REALM ?? "").trim();
const keycloakClientId = String(
	import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "",
).trim();

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
		? createMissingConfigKeycloakStub()
		: new Keycloak({
				url: keycloakUrl,
				realm: keycloakRealm,
				clientId: keycloakClientId,
			});

export async function initKeycloak(): Promise<boolean> {
	return keycloak.init({
		onLoad: "check-sso",
		pkceMethod: "S256",
		checkLoginIframe: false,
	});
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
	if (!headers.has("Accept")) {
		headers.set("Accept", "application/json");
	}

	return fetch(input, {
		...init,
		headers,
	});
}
