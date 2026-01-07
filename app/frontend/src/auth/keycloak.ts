import Keycloak from "keycloak-js";

const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL;
const keycloakRealm = import.meta.env.VITE_KEYCLOAK_REALM;
const keycloakClientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID;

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

export const keycloak: KeycloakLike = isCypressRun()
	? createCypressKeycloakStub()
	: new Keycloak({
			url: keycloakUrl,
			realm: keycloakRealm,
			clientId: keycloakClientId,
		});

export async function initKeycloak(): Promise<boolean> {
	return keycloak.init({
		onLoad: "check-sso",
		pkceMethod: "S256",
		silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
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
