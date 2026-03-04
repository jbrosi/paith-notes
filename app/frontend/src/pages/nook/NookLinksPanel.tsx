import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import type { NookStore } from "./store";
import {
	type LinkPredicate,
	LinkPredicateResponseSchema,
	type LinkPredicateRule,
	LinkPredicateRulesListResponseSchema,
	LinkPredicatesListResponseSchema,
} from "./types";

export type NookLinksPanelProps = {
	store: NookStore;
};

export function NookLinksPanel(props: NookLinksPanelProps) {
	const store = () => props.store;
	const nookId = () => store().nookId();

	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [predicates, setPredicates] = createSignal<LinkPredicate[]>([]);
	const [selectedPredicateId, setSelectedPredicateId] =
		createSignal<string>("");
	const [rules, setRules] = createSignal<LinkPredicateRule[]>([]);

	const selectedPredicate = createMemo(() => {
		const id = selectedPredicateId().trim();
		if (id === "") return null;
		return predicates().find((p) => p.id === id) ?? null;
	});

	const loadPredicates = async () => {
		if (nookId().trim() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/link-predicates`, {
				method: "GET",
			});
			if (!res.ok) {
				throw new Error(
					`Failed to load link predicates: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicatesListResponseSchema.parse(json);
			setPredicates(body.predicates);
			if (
				selectedPredicateId().trim() !== "" &&
				!body.predicates.some((p) => p.id === selectedPredicateId())
			) {
				setSelectedPredicateId("");
			}
		} catch (e) {
			setPredicates([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const loadRules = async (predicateId: string) => {
		const pid = predicateId.trim();
		if (pid === "") {
			setRules([]);
			return;
		}
		if (nookId().trim() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/link-predicates/${pid}/rules`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to load rules: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicateRulesListResponseSchema.parse(json);
			setRules(body.rules);
		} catch (e) {
			setRules([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const savePredicate = async (p: LinkPredicate) => {
		if (nookId().trim() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/link-predicates/${p.id}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						key: p.key,
						forward_label: p.forwardLabel,
						reverse_label: p.reverseLabel,
						supports_start_date: p.supportsStartDate,
						supports_end_date: p.supportsEndDate,
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to save predicate: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicateResponseSchema.parse(json);
			setPredicates(
				predicates().map((x) =>
					x.id === body.predicate.id ? body.predicate : x,
				),
			);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const createPredicate = async () => {
		if (nookId().trim() === "") return;
		const key = window.prompt("Predicate key (unique)")?.trim() ?? "";
		if (key === "") return;
		const forward = window.prompt("Forward label", key)?.trim() ?? "";
		if (forward === "") return;
		const reverse = window.prompt("Reverse label")?.trim() ?? "";
		if (reverse === "") return;
		const supportsStart = window.confirm("Support start date?");
		const supportsEnd = window.confirm("Support end date?");

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/link-predicates`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key,
					forward_label: forward,
					reverse_label: reverse,
					supports_start_date: supportsStart,
					supports_end_date: supportsEnd,
				}),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to create predicate: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicateResponseSchema.parse(json);
			setPredicates([body.predicate, ...predicates()]);
			setSelectedPredicateId(body.predicate.id);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const deletePredicate = async (p: LinkPredicate) => {
		if (nookId().trim() === "") return;
		if (!window.confirm(`Delete predicate "${p.key}"?`)) return;

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/link-predicates/${p.id}`,
				{ method: "DELETE" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to delete predicate: ${res.status} ${res.statusText}`,
				);
			}
			setPredicates(predicates().filter((x) => x.id !== p.id));
			if (selectedPredicateId() === p.id) {
				setSelectedPredicateId("");
				setRules([]);
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const saveRules = async (
		predicateId: string,
		nextRules: LinkPredicateRule[],
	) => {
		if (nookId().trim() === "") return;
		const pid = predicateId.trim();
		if (pid === "") return;

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/link-predicates/${pid}/rules`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						rules: nextRules.map((r) => ({
							source_type_id: r.sourceTypeId,
							target_type_id: r.targetTypeId,
							include_source_subtypes: r.includeSourceSubtypes,
							include_target_subtypes: r.includeTargetSubtypes,
						})),
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to save rules: ${res.status} ${res.statusText}`,
				);
			}
			await loadRules(pid);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	createEffect(() => {
		void store().loadNoteTypes();
	});

	createEffect(() => {
		void loadPredicates();
	});

	createEffect(() => {
		const pid = selectedPredicateId().trim();
		if (pid === "") {
			setRules([]);
			return;
		}
		void loadRules(pid);
	});

	return (
		<div
			style={{
				padding: "8px",
				border: "1px solid #eee",
				"border-radius": "8px",
			}}
		>
			<div
				style={{
					display: "flex",
					"justify-content": "space-between",
					"align-items": "center",
				}}
			>
				<div style={{ "font-weight": 700 }}>Links</div>
				<div style={{ display: "flex", gap: "8px" }}>
					<Button variant="secondary" onClick={() => void loadPredicates()}>
						Refresh
					</Button>
					<Button onClick={() => void createPredicate()}>New predicate</Button>
				</div>
			</div>

			<Show when={error() !== ""}>
				<pre style={{ color: "#b42318", "white-space": "pre-wrap" }}>
					{error()}
				</pre>
			</Show>

			<div style={{ display: "flex", gap: "12px", "margin-top": "12px" }}>
				<div style={{ width: "260px", "flex-shrink": "0" }}>
					<div style={{ "font-weight": 600, "margin-bottom": "6px" }}>
						Predicates
					</div>
					<For each={predicates()}>
						{(p) => (
							<div
								style={{
									display: "flex",
									gap: "6px",
									"align-items": "center",
									padding: "6px",
									border: "1px solid #ddd",
									"border-radius": "6px",
									"margin-bottom": "6px",
									background:
										selectedPredicateId() === p.id ? "#f6f8fa" : "white",
								}}
							>
								<button
									type="button"
									onClick={() => setSelectedPredicateId(p.id)}
									style={{
										flex: "1",
										border: "none",
										background: "transparent",
										"text-align": "left",
										cursor: "pointer",
									}}
									title={p.id}
								>
									{p.key}
								</button>
								<Button
									variant="secondary"
									onClick={() => void deletePredicate(p)}
								>
									Delete
								</Button>
							</div>
						)}
					</For>
					<Show when={!loading() && predicates().length === 0}>
						<div style={{ color: "#666" }}>(none)</div>
					</Show>
				</div>

				<div style={{ flex: "1", "min-width": "0" }}>
					<Show
						when={selectedPredicate()}
						keyed
						fallback={<div>Select a predicate</div>}
					>
						{(p0) => {
							const [key, setKey] = createSignal(p0.key);
							const [forward, setForward] = createSignal(p0.forwardLabel);
							const [reverse, setReverse] = createSignal(p0.reverseLabel);
							const [supportsStart, setSupportsStart] = createSignal(
								p0.supportsStartDate,
							);
							const [supportsEnd, setSupportsEnd] = createSignal(
								p0.supportsEndDate,
							);

							return (
								<div
									style={{
										display: "flex",
										"flex-direction": "column",
										gap: "10px",
									}}
								>
									<div style={{ "font-weight": 600 }}>Predicate</div>
									<label>
										Key
										<input
											value={key()}
											onInput={(e) => setKey(e.currentTarget.value)}
											style={{
												width: "100%",
												padding: "8px",
												"box-sizing": "border-box",
											}}
										/>
									</label>
									<label>
										Forward label
										<input
											value={forward()}
											onInput={(e) => setForward(e.currentTarget.value)}
											style={{
												width: "100%",
												padding: "8px",
												"box-sizing": "border-box",
											}}
										/>
									</label>
									<label>
										Reverse label
										<input
											value={reverse()}
											onInput={(e) => setReverse(e.currentTarget.value)}
											style={{
												width: "100%",
												padding: "8px",
												"box-sizing": "border-box",
											}}
										/>
									</label>
									<div
										style={{
											display: "flex",
											gap: "12px",
											"align-items": "center",
										}}
									>
										<label
											style={{
												display: "flex",
												gap: "6px",
												"align-items": "center",
											}}
										>
											<input
												type="checkbox"
												checked={supportsStart()}
												onChange={(e) =>
													setSupportsStart(e.currentTarget.checked)
												}
											/>
											Support start date
										</label>
										<label
											style={{
												display: "flex",
												gap: "6px",
												"align-items": "center",
											}}
										>
											<input
												type="checkbox"
												checked={supportsEnd()}
												onChange={(e) =>
													setSupportsEnd(e.currentTarget.checked)
												}
											/>
											Support end date
										</label>
									</div>

									<div style={{ display: "flex", gap: "8px" }}>
										<Button
											variant="secondary"
											onClick={() => {
												setKey(p0.key);
												setForward(p0.forwardLabel);
												setReverse(p0.reverseLabel);
												setSupportsStart(p0.supportsStartDate);
												setSupportsEnd(p0.supportsEndDate);
											}}
										>
											Reset
										</Button>
										<Button
											onClick={() =>
												void savePredicate({
													...p0,
													key: key().trim(),
													forwardLabel: forward().trim(),
													reverseLabel: reverse().trim(),
													supportsStartDate: supportsStart(),
													supportsEndDate: supportsEnd(),
												})
											}
										>
											Save
										</Button>
									</div>

									<div style={{ "margin-top": "12px", "font-weight": 600 }}>
										Rules
									</div>
									<div style={{ color: "#666", "font-size": "12px" }}>
										If no rules exist, this predicate is allowed for all types.
									</div>

									<div
										style={{
											display: "flex",
											"flex-direction": "column",
											gap: "8px",
										}}
									>
										<For each={rules()}>
											{(r, idx) => {
												const allTypes = store().noteTypes();
												return (
													<div
														style={{
															display: "flex",
															gap: "8px",
															"align-items": "center",
															padding: "6px",
															border: "1px solid #ddd",
															"border-radius": "6px",
														}}
													>
														<label style={{ flex: "1" }}>
															Source type
															<select
																value={r.sourceTypeId}
																onChange={(e) => {
																	const next = rules().slice();
																	next[idx()] = {
																		...next[idx()],
																		sourceTypeId: e.currentTarget.value,
																	};
																	setRules(next);
																}}
																style={{ width: "100%", padding: "6px" }}
															>
																<option value="">(any)</option>
																<For each={allTypes}>
																	{(t) => (
																		<option value={t.id}>{t.label}</option>
																	)}
																</For>
															</select>
														</label>

														<label style={{ flex: "1" }}>
															Target type
															<select
																value={r.targetTypeId}
																onChange={(e) => {
																	const next = rules().slice();
																	next[idx()] = {
																		...next[idx()],
																		targetTypeId: e.currentTarget.value,
																	};
																	setRules(next);
																}}
																style={{ width: "100%", padding: "6px" }}
															>
																<option value="">(any)</option>
																<For each={allTypes}>
																	{(t) => (
																		<option value={t.id}>{t.label}</option>
																	)}
																</For>
															</select>
														</label>

														<label
															style={{
																display: "flex",
																gap: "6px",
																"align-items": "center",
															}}
														>
															<input
																type="checkbox"
																checked={r.includeSourceSubtypes}
																onChange={(e) => {
																	const next = rules().slice();
																	next[idx()] = {
																		...next[idx()],
																		includeSourceSubtypes:
																			e.currentTarget.checked,
																	};
																	setRules(next);
																}}
															/>
															Subtypes
														</label>

														<label
															style={{
																display: "flex",
																gap: "6px",
																"align-items": "center",
															}}
														>
															<input
																type="checkbox"
																checked={r.includeTargetSubtypes}
																onChange={(e) => {
																	const next = rules().slice();
																	next[idx()] = {
																		...next[idx()],
																		includeTargetSubtypes:
																			e.currentTarget.checked,
																	};
																	setRules(next);
																}}
															/>
															Subtypes
														</label>

														<Button
															variant="secondary"
															onClick={() => {
																const next = rules().slice();
																next.splice(idx(), 1);
																setRules(next);
															}}
														>
															Remove
														</Button>
													</div>
												);
											}}
										</For>

										<div
											style={{
												display: "flex",
												gap: "8px",
												"align-items": "center",
											}}
										>
											<Button
												variant="secondary"
												onClick={() => {
													setRules([
														...rules(),
														{
															id: 0,
															predicateId: p0.id,
															sourceTypeId: "",
															targetTypeId: "",
															includeSourceSubtypes: true,
															includeTargetSubtypes: true,
														},
													]);
												}}
											>
												Add rule
											</Button>
											<Button onClick={() => void saveRules(p0.id, rules())}>
												Save rules
											</Button>
										</div>
									</div>
								</div>
							);
						}}
					</Show>
				</div>
			</div>
		</div>
	);
}
