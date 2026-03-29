import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { Button } from "../../../components/Button";
import { RemoteNoteSearchSelect } from "../../../components/RemoteNoteSearchSelect";
import css from "../NookNoteLinksPanel.module.css";
import type { NookStore } from "../store";
import {
	type LinkPredicate,
	type LinkPredicateRule,
	LinkPredicateRulesListResponseSchema,
	LinkPredicatesListResponseSchema,
	type NoteLink,
	NoteLinkResponseSchema,
} from "../types";

type Props = {
	store: NookStore;
	nookId: string;
	noteId: string;
	onLinkCreated: (link: NoteLink) => void;
	onError: (msg: string) => void;
};

export function AddLinkForm(props: Props) {
	const [loading, setLoading] = createSignal(false);
	const [predicates, setPredicates] = createSignal<LinkPredicate[]>([]);
	const [rules, setRules] = createSignal<LinkPredicateRule[]>([]);
	const [predicateId, setPredicateId] = createSignal("");
	const [targetNoteId, setTargetNoteId] = createSignal("");
	const [startDate, setStartDate] = createSignal("");
	const [endDate, setEndDate] = createSignal("");

	const typeParentById = createMemo(() => {
		const m = new Map<string, string>();
		for (const t of props.store.noteTypes()) m.set(t.id, t.parentId);
		return m;
	});

	const isSameOrDescendant = (childId: string, ancestorId: string) => {
		const child = childId.trim();
		const ancestor = ancestorId.trim();
		if (child === "" || ancestor === "") return false;
		if (child === ancestor) return true;
		let cur = child;
		const parentMap = typeParentById();
		for (let i = 0; i < 64; i++) {
			const p = parentMap.get(cur) ?? "";
			if (p === "") return false;
			if (p === ancestor) return true;
			cur = p;
		}
		return false;
	};

	const loadPredicates = async () => {
		if (!props.nookId) return;
		setLoading(true);
		try {
			const res = await apiFetch(`/api/nooks/${props.nookId}/link-predicates`, {
				method: "GET",
			});
			if (!res.ok) throw new Error(`Failed: ${res.status}`);
			const body = LinkPredicatesListResponseSchema.parse(await res.json());
			setPredicates(body.predicates);
			if (predicateId() === "" && body.predicates.length > 0) {
				setPredicateId(body.predicates[0].id);
			}
		} catch (e) {
			setPredicates([]);
			props.onError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const loadRules = async (pid: string) => {
		if (!pid || !props.nookId) {
			setRules([]);
			return;
		}
		setLoading(true);
		try {
			const res = await apiFetch(
				`/api/nooks/${props.nookId}/link-predicates/${pid}/rules`,
				{ method: "GET" },
			);
			if (!res.ok) throw new Error(`Failed: ${res.status}`);
			const body = LinkPredicateRulesListResponseSchema.parse(await res.json());
			setRules(body.rules);
		} catch (e) {
			setRules([]);
			props.onError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const submit = async () => {
		const pid = predicateId().trim();
		if (!pid) {
			props.onError("Choose a predicate");
			return;
		}
		const tid = targetNoteId().trim();
		if (!tid) {
			props.onError("Choose a target note");
			return;
		}
		if (tid === props.noteId) {
			props.onError("Cannot link a note to itself");
			return;
		}

		setLoading(true);
		try {
			const res = await apiFetch(
				`/api/nooks/${props.nookId}/notes/${props.noteId}/links`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						predicate_id: pid,
						target_note_id: tid,
						start_date: startDate().trim() || undefined,
						end_date: endDate().trim() || undefined,
					}),
				},
			);
			if (!res.ok) throw new Error(`Failed: ${res.status}`);
			const body = NoteLinkResponseSchema.parse(await res.json());
			props.onLinkCreated(body.link);
			setStartDate("");
			setEndDate("");
		} catch (e) {
			props.onError(String(e));
		} finally {
			setLoading(false);
		}
	};

	// Allowed target types based on predicate rules
	const allowedTargetTypeOptions = createMemo(() => {
		const sourceTypeId = props.store.typeId().trim();
		const activeRules = rules();
		const types = props.store.noteTypes();
		const typeById = new Map(types.map((t) => [t.id, t.label] as const));

		if (activeRules.length === 0) {
			return types.map((t) => ({ id: t.id, label: t.label }));
		}

		const allowed = new Set<string>();
		let anyAllowed = false;
		for (const r of activeRules) {
			const ruleSource = r.sourceTypeId.trim();
			const sourceOk =
				ruleSource === "" ||
				(sourceTypeId !== "" &&
					(r.includeSourceSubtypes
						? isSameOrDescendant(sourceTypeId, ruleSource)
						: sourceTypeId === ruleSource));
			if (!sourceOk) continue;
			if (r.targetTypeId.trim() === "") {
				anyAllowed = true;
				break;
			}
			allowed.add(r.targetTypeId.trim());
		}

		if (anyAllowed) return types.map((t) => ({ id: t.id, label: t.label }));
		return Array.from(allowed)
			.map((id) => ({ id, label: typeById.get(id) ?? id }))
			.sort((a, b) => a.label.localeCompare(b.label));
	});

	const allowedTargetTypeIds = createMemo(
		() => new Set(allowedTargetTypeOptions().map((o) => o.id)),
	);

	const allowedTargetTypeLabel = createMemo(() =>
		allowedTargetTypeOptions()
			.map((o) => o.label)
			.join(", "),
	);

	const isTypeAllowed = (typeId: string) => {
		const id = typeId.trim();
		if (id === "") return false;
		const allowed = allowedTargetTypeIds();
		if (allowed.size === 0) return true;
		for (const rootId of allowed) {
			if (id === rootId || isSameOrDescendant(id, rootId)) return true;
		}
		return false;
	};

	createEffect(() => void loadPredicates());
	createEffect(() => {
		const pid = predicateId().trim();
		setTargetNoteId("");
		void loadRules(pid);
	});
	createEffect(() => {
		void props.noteId;
		setTargetNoteId("");
		setStartDate("");
		setEndDate("");
	});

	return (
		<>
			<div class={css.formGrid}>
				<label>
					Predicate
					<select
						value={predicateId()}
						onChange={(e) => setPredicateId(e.currentTarget.value)}
						disabled={loading()}
						class={css.formInput}
					>
						<For each={predicates()}>
							{(p) => (
								<option value={p.id}>
									{p.key} ({p.forwardLabel} / {p.reverseLabel})
								</option>
							)}
						</For>
					</select>
				</label>

				<div>
					<div>Target note</div>
					<RemoteNoteSearchSelect
						value={targetNoteId()}
						onChange={(id) => setTargetNoteId(id)}
						nookId={props.nookId}
						noteTypes={props.store.noteTypes()}
						excludeIds={[props.noteId]}
						isTypeAllowed={(id) => isTypeAllowed(id)}
						allowedTypesLabel={allowedTargetTypeLabel()}
						placeholder="Target note..."
						disabled={loading()}
					/>
				</div>
			</div>

			<div class={css.formGrid}>
				<label>
					Start date
					<input
						type="date"
						value={startDate()}
						onInput={(e) => setStartDate(e.currentTarget.value)}
						disabled={loading()}
						class={css.formInput}
					/>
				</label>
				<label>
					End date
					<input
						type="date"
						value={endDate()}
						onInput={(e) => setEndDate(e.currentTarget.value)}
						disabled={loading()}
						class={css.formInput}
					/>
				</label>
			</div>

			<Button onClick={() => void submit()} disabled={loading()}>
				Add link
			</Button>
		</>
	);
}
