import { createSignal, For, onMount, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import styles from "./NookSettingsLanding.module.css";

/**
 * Owner-only sharing section: invite by email, revoke pending
 * invitations, revoke existing members. Extracted from
 * NookSettingsLanding to keep that file focused; state is fully
 * self-contained here so the parent doesn't have to thread it.
 *
 * Non-owner members don't see this section at all (parent controls
 * mounting via `<Show when={isOwner}>`), so no read-only fallback is
 * needed here.
 */

type Props = {
	nookId: string;
	nookRole: string;
};

type MemberItem = {
	id: string;
	name: string;
	email: string;
	role: string;
	joined_at: string;
};

type InvitationItem = {
	id: string;
	invited_email: string;
	role: string;
	status: string;
	inviter_name: string;
	created_at: string;
};

export function NookSharingSection(props: Props) {
	const isOwner = () => props.nookRole === "owner";

	const [members, setMembers] = createSignal<MemberItem[]>([]);
	const [nookInvitations, setNookInvitations] = createSignal<InvitationItem[]>(
		[],
	);
	const [inviteEmail, setInviteEmail] = createSignal("");
	const [inviteRole, setInviteRole] = createSignal<"readonly" | "readwrite">(
		"readonly",
	);
	const [sharingError, setSharingError] = createSignal("");

	const loadSharing = async () => {
		if (!isOwner()) return;
		try {
			const [mRes, iRes] = await Promise.all([
				apiFetch(`/api/nooks/${encodeURIComponent(props.nookId)}/members`, {
					method: "GET",
				}),
				apiFetch(`/api/nooks/${encodeURIComponent(props.nookId)}/invitations`, {
					method: "GET",
				}),
			]);
			if (mRes.ok) {
				const body = (await mRes.json()) as { members?: unknown };
				const list = Array.isArray(body?.members) ? body.members : [];
				setMembers(
					list
						.filter(
							(m: unknown): m is Record<string, unknown> =>
								!!m && typeof m === "object",
						)
						.map((m) => ({
							id: String(m.id ?? ""),
							name: String(m.name ?? ""),
							email: String(m.email ?? ""),
							role: String(m.role ?? ""),
							joined_at: String(m.joined_at ?? ""),
						})),
				);
			}
			if (iRes.ok) {
				const body = (await iRes.json()) as { invitations?: unknown };
				const list = Array.isArray(body?.invitations) ? body.invitations : [];
				setNookInvitations(
					list
						.filter(
							(i: unknown): i is Record<string, unknown> =>
								!!i && typeof i === "object",
						)
						.map((i) => ({
							id: String(i.id ?? ""),
							invited_email: String(i.invited_email ?? ""),
							role: String(i.role ?? ""),
							status: String(i.status ?? ""),
							inviter_name: String(i.inviter_name ?? ""),
							created_at: String(i.created_at ?? ""),
						})),
				);
			}
		} catch {
			// best-effort — sharing panel is non-critical, avoid throwing
			// when the fetch fails for e.g. transient network issues.
		}
	};

	const sendInvite = async () => {
		const email = inviteEmail().trim();
		if (!email) return;
		setSharingError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/invitations`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, role: inviteRole() }),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body?.error || `Failed: ${res.status}`);
			}
			setInviteEmail("");
			await loadSharing();
		} catch (e) {
			setSharingError(e instanceof Error ? e.message : String(e));
		}
	};

	const revokeInvitation = async (invId: string, email: string) => {
		if (!window.confirm(`Revoke invitation to ${email || "this address"}?`)) {
			return;
		}
		try {
			await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/invitations/${encodeURIComponent(invId)}`,
				{ method: "DELETE" },
			);
			await loadSharing();
		} catch {
			// best-effort
		}
	};

	const revokeMember = async (userId: string, name: string) => {
		if (
			!window.confirm(
				`Remove ${name || "this member"} from this nook? They lose access immediately.`,
			)
		) {
			return;
		}
		try {
			await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/members/${encodeURIComponent(userId)}`,
				{ method: "DELETE" },
			);
			await loadSharing();
		} catch {
			// best-effort
		}
	};

	onMount(() => {
		if (isOwner()) void loadSharing();
	});

	return (
		<Show when={isOwner()}>
			<div class={styles.section}>
				<div class={styles.sectionTitle}>Sharing</div>

				{/* Invite form */}
				<div class={styles.inviteForm}>
					<input
						type="email"
						placeholder="Email address..."
						value={inviteEmail()}
						onInput={(e) => setInviteEmail(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void sendInvite();
						}}
						class={styles.inviteInput}
					/>
					<select
						value={inviteRole()}
						onChange={(e) =>
							setInviteRole(e.currentTarget.value as "readonly" | "readwrite")
						}
						class={styles.inviteSelect}
					>
						<option value="readonly">Read-only</option>
						<option value="readwrite">Read-write</option>
					</select>
					<Button
						variant="primary"
						size="small"
						onClick={() => void sendInvite()}
						disabled={inviteEmail().trim() === ""}
					>
						Invite
					</Button>
				</div>
				<Show when={sharingError().trim() !== ""}>
					<div class={styles.sharingError}>{sharingError()}</div>
				</Show>

				{/* Pending invitations */}
				<Show
					when={
						nookInvitations().filter((i) => i.status === "pending").length > 0
					}
				>
					<div class={styles.sharingSubtitle}>Pending invitations</div>
					<For each={nookInvitations().filter((i) => i.status === "pending")}>
						{(inv) => (
							<div class={styles.sharingRow}>
								<span class={styles.sharingEmail}>{inv.invited_email}</span>
								<span class={styles.sharingRole}>
									{inv.role === "readonly" ? "read-only" : "read-write"}
								</span>
								<Button
									variant="secondary"
									size="small"
									onClick={() =>
										void revokeInvitation(inv.id, inv.invited_email)
									}
								>
									Revoke
								</Button>
							</div>
						)}
					</For>
				</Show>

				{/* Current members */}
				<Show when={members().length > 0}>
					<div class={styles.sharingSubtitle}>Members</div>
					<For each={members()}>
						{(m) => (
							<div class={styles.sharingRow}>
								<span class={styles.sharingEmail}>
									{m.name || m.email}
									<Show when={m.name && m.email}>
										<span class={styles.sharingEmailSub}> ({m.email})</span>
									</Show>
								</span>
								<span class={styles.sharingRole}>{m.role}</span>
								<Show when={m.role !== "owner"}>
									<Button
										variant="secondary"
										size="small"
										onClick={() => void revokeMember(m.id, m.name || m.email)}
									>
										Revoke access
									</Button>
								</Show>
							</div>
						)}
					</For>
				</Show>
			</div>
		</Show>
	);
}
