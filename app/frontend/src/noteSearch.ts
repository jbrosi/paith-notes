import type { NoteSummary } from "./pages/nook/types";

export function normalizeToken(v: string): string {
	return String(v ?? "")
		.trim()
		.toLowerCase();
}

export function parseTypedSearch(raw: string): {
	typeTerm: string;
	textTerm: string;
	explicitNoType: boolean;
} {
	const s = String(raw ?? "").trim();
	const idx = s.indexOf(":");
	if (idx <= 0) {
		if (idx === 0) {
			return {
				typeTerm: "",
				textTerm: s.slice(1).trim(),
				explicitNoType: true,
			};
		}
		return { typeTerm: "", textTerm: s, explicitNoType: false };
	}
	const left = s.slice(0, idx).trim();
	const right = s.slice(idx + 1).trim();
	if (left === "") {
		return { typeTerm: "", textTerm: right, explicitNoType: true };
	}
	return { typeTerm: left, textTerm: right, explicitNoType: false };
}

export function resolveTypeForTerm<T extends { key: string; label: string }>(
	types: T[],
	termRaw: string,
): T | null {
	const term = normalizeToken(termRaw);
	if (term === "") return null;

	let prefix: T | null = null;
	let contains: T | null = null;
	for (const t of types) {
		const label = normalizeToken(t.label);
		const key = normalizeToken(t.key);
		if (label.startsWith(term) || key.startsWith(term)) {
			prefix = t;
			break;
		}
		if (contains === null && (label.includes(term) || key.includes(term))) {
			contains = t;
		}
	}
	return prefix ?? contains;
}

export function resolveTypeIdForTerm<
	T extends { id: string; key: string; label: string },
>(types: T[], termRaw: string): string {
	return resolveTypeForTerm(types, termRaw)?.id ?? "";
}

export function rankNotesByQuery(
	items: NoteSummary[],
	qRaw: string,
): NoteSummary[] {
	const q = normalizeToken(qRaw);
	if (q === "") return items;
	const withRank = items.map((n, i) => {
		const title = normalizeToken(n.title);
		const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : 2;
		return { n, i, rank };
	});
	withRank.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i));
	return withRank.map((x) => x.n);
}
