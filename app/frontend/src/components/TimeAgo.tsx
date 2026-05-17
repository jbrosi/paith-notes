import { createSignal, onCleanup, onMount } from "solid-js";

type Props = {
	date: string;
};

function formatRelative(iso: string): string {
	try {
		const d = new Date(iso);
		const now = Date.now();
		const diffMs = now - d.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return "just now";
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffH = Math.floor(diffMin / 60);
		if (diffH < 24) return `${diffH}h ago`;
		const diffD = Math.floor(diffH / 24);
		if (diffD < 7) return `${diffD}d ago`;
		if (diffD < 30) return `${Math.floor(diffD / 7)}w ago`;
		return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
	} catch {
		return iso;
	}
}

function formatFull(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, {
			day: "numeric",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

/**
 * Shows relative time ("2h ago") with full date on hover.
 * Auto-updates every minute.
 */
export function TimeAgo(props: Props) {
	const [text, setText] = createSignal(formatRelative(props.date));

	onMount(() => {
		const interval = setInterval(() => {
			setText(formatRelative(props.date));
		}, 60000);
		onCleanup(() => clearInterval(interval));
	});

	return (
		<span title={formatFull(props.date)} style={{ color: "var(--color-text-muted, #aaa)" }}>
			{text()}
		</span>
	);
}
