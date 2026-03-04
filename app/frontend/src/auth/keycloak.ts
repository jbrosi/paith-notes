function isCypressRun(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as unknown as { Cypress?: unknown }).Cypress !== "undefined"
	);
}

export async function isAuthenticated(): Promise<boolean> {
	if (isCypressRun()) {
		return true;
	}

	const res = await fetch("/api/auth/check", {
		method: "GET",
		credentials: "include",
	});
	return res.ok;
}

export function login(redirectTo?: string): void {
	const target = redirectTo?.trim()
		? redirectTo.trim()
		: `${window.location.pathname}${window.location.search}${window.location.hash}`;
	window.location.href = `/api/auth/login?redirect=${encodeURIComponent(target)}`;
}

export async function logout(): Promise<void> {
	if (isCypressRun()) {
		window.location.href = "/";
		return;
	}
	window.location.href = "/api/auth/logout";
}

export async function logoutSso(): Promise<void> {
	if (isCypressRun()) {
		window.location.href = "/";
		return;
	}
	window.location.href = "/api/auth/logout/sso";
}

export async function apiFetch(
	input: RequestInfo | URL,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);

	if (isCypressRun() || import.meta.env.DEV) {
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
		credentials: "include",
		headers,
	});
}
