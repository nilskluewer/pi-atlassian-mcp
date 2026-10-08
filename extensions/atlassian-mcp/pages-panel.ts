/**
 * Interactive panel for /atlassian-pages.
 *
 * Shows the Confluence page trees the agent may edit, and lets the user add
 * and remove root pages, then apply the result to the session or save it as a
 * global or project default. Changes are a draft until an apply action is
 * chosen; esc discards them.
 *
 * Adding a page needs a text input and a network check, so the panel closes
 * with an "add" result, the caller asks for the URL and validates it, and then
 * opens the panel again with the updated draft.
 *
 * Non-TUI front ends (RPC) cannot render components, so they get a
 * select-dialog loop with the same actions.
 */

import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, SelectList, type SelectItem, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { pageScopeKey, type PageScope } from "./scope.ts";

export type PagesPanelAction = "add" | "session" | "global" | "project";

export interface PagesPanelResult {
	action: PagesPanelAction;
	draft: PageScope[];
}

export interface PagesPanelState {
	/** The working list, possibly with unsaved changes. */
	draft: PageScope[];
	/** What is enforced right now, to detect unsaved changes. */
	active: PageScope[];
	/** Where the active scope comes from, e.g. "project default". */
	source: string;
	/** Set when the active scope is unreadable and all writes are blocked. */
	invalidReason?: string;
	canSaveProject: boolean;
	/** Row to highlight when the panel opens again. */
	focusAction?: PagesPanelAction;
}

interface PanelCtx {
	mode: string;
	ui: {
		custom: <T>(
			factory: (tui: { requestRender: () => void }, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
		) => Promise<T>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
	};
}

const MAX_VISIBLE = 12;
const PAGE_PREFIX = "page:";
const ACTION_PREFIX = "action:";

export function pageLabel(scope: PageScope): string {
	return scope.title ?? `Page ${scope.rootPageId}`;
}

export function pageDetail(scope: PageScope): string {
	return `${scope.siteHost} · page ${scope.rootPageId} + all child pages`;
}

export function treeCount(count: number): string {
	return count === 1 ? "1 page tree" : `${count} page trees`;
}

/** Wide enough for typical Confluence titles; longer ones are truncated. */
const LIST_LAYOUT = { minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 56 };

function sameScopes(a: PageScope[], b: PageScope[]): boolean {
	const keys = (list: PageScope[]) => list.map(pageScopeKey).sort().join(",");
	return keys(a) === keys(b);
}

function actionItems(state: PagesPanelState, draft: PageScope[]): SelectItem[] {
	const restricted = draft.length > 0;
	return [
		{ value: `${ACTION_PREFIX}add`, label: "+ Add root page", description: "Paste a Confluence page URL" },
		{
			value: `${ACTION_PREFIX}session`,
			label: "▸ Apply to this session",
			description: restricted ? "Not saved; new sessions use the saved default" : "Remove the restriction for this session",
		},
		{ value: `${ACTION_PREFIX}global`, label: "▸ Save as global default", description: "Apply now and in every new session" },
		...(state.canSaveProject
			? [{ value: `${ACTION_PREFIX}project`, label: "▸ Save as project default", description: "Apply now and in new sessions in this project" }]
			: []),
	];
}

export async function openPagesPanel(ctx: PanelCtx, state: PagesPanelState): Promise<PagesPanelResult | undefined> {
	return ctx.mode === "tui" ? openComponent(ctx, state) : openSelectLoop(ctx, state);
}

async function openComponent(ctx: PanelCtx, state: PagesPanelState): Promise<PagesPanelResult | undefined> {
	const result = await ctx.ui.custom<PagesPanelResult | null>((tui, theme, _keybindings, done) => {
		const draft = [...state.draft];
		const border = new DynamicBorder((line: string) => theme.fg("accent", line));
		const header = new Text("", 0, 0);
		const hint = new Text("", 0, 0);
		let list: SelectList;

		const buildList = (focusValue?: string) => {
			const items: SelectItem[] = [
				...draft.map((scope) => ({
					value: `${PAGE_PREFIX}${pageScopeKey(scope)}`,
					label: `✎ ${pageLabel(scope)}`,
					description: pageDetail(scope),
				})),
				...actionItems(state, draft),
			];
			list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), LIST_LAYOUT);
			const index = focusValue ? items.findIndex((item) => item.value === focusValue) : -1;
			list.setSelectedIndex(index >= 0 ? index : 0);
			list.onSelect = (item) => {
				// Enter on a page row does nothing harmful: removal needs an explicit key.
				if (item.value.startsWith(ACTION_PREFIX)) {
					done({ action: item.value.slice(ACTION_PREFIX.length) as PagesPanelAction, draft });
				}
			};
			list.onCancel = () => done(null);
		};

		const refreshChrome = () => {
			const lines = [theme.fg("accent", theme.bold("Confluence page scope"))];
			if (draft.length > 0) {
				lines.push(
					theme.fg("success", `The agent can edit ${treeCount(draft.length)}. All other Confluence pages are read-only.`),
				);
			} else {
				lines.push(theme.fg("warning", "No restriction: the agent can edit every Confluence page that you can edit."));
			}
			if (state.invalidReason) {
				lines.push(theme.fg("error", `Now: all Confluence edits are blocked (${state.invalidReason}).`));
			} else {
				lines.push(theme.fg("muted", `Now active: ${state.source}`));
			}
			if (!sameScopes(draft, state.active) || state.invalidReason) {
				lines.push(theme.fg("warning", "Unsaved changes - choose an action below to apply them."));
			}
			header.setText(lines.join("\n"));

			const selected = list.getSelectedItem();
			const onPage = selected?.value.startsWith(PAGE_PREFIX);
			hint.setText(
				theme.fg(
					"muted",
					`↑/↓ move  ·  enter select${onPage ? "  ·  d or del remove page" : ""}  ·  esc discard changes`,
				),
			);
		};

		buildList(state.focusAction ? `${ACTION_PREFIX}${state.focusAction}` : undefined);
		refreshChrome();

		return {
			render(width: number): string[] {
				return [
					...border.render(width),
					...header.render(width),
					"",
					...list.render(width),
					"",
					...hint.render(width),
					...border.render(width),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string): void {
				const selected = list.getSelectedItem();
				const removeKey = data === "d" || matchesKey(data, "delete") || matchesKey(data, "backspace");
				if (removeKey && selected?.value.startsWith(PAGE_PREFIX)) {
					const key = selected.value.slice(PAGE_PREFIX.length);
					const index = draft.findIndex((scope) => pageScopeKey(scope) === key);
					if (index >= 0) draft.splice(index, 1);
					// Keep the cursor near the removed row.
					const next = draft[Math.min(index, draft.length - 1)];
					buildList(next ? `${PAGE_PREFIX}${pageScopeKey(next)}` : `${ACTION_PREFIX}add`);
				} else {
					list.handleInput(data);
				}
				refreshChrome();
				tui.requestRender();
			},
			invalidate(): void {
				border.invalidate();
				list.invalidate();
				refreshChrome();
			},
		};
	});
	return result ?? undefined;
}

/** Select-dialog fallback for front ends without component support. */
async function openSelectLoop(ctx: PanelCtx, state: PagesPanelState): Promise<PagesPanelResult | undefined> {
	const draft = [...state.draft];
	while (true) {
		const pageOptions = draft.map((scope) => `Remove: ${pageLabel(scope)} (${scope.rootPageId})`);
		const actions = actionItems(state, draft);
		const title =
			draft.length > 0
				? `Confluence page scope - the agent can edit ${treeCount(draft.length)}, all other pages are read-only:`
				: "Confluence page scope - no restriction:";
		const choice = await ctx.ui.select(title, [...pageOptions, ...actions.map((a) => a.label), "Cancel"]);
		if (!choice || choice === "Cancel") return undefined;

		const pageIndex = pageOptions.indexOf(choice);
		if (pageIndex >= 0) {
			draft.splice(pageIndex, 1);
			continue;
		}
		const action = actions.find((a) => a.label === choice);
		if (action) return { action: action.value.slice(ACTION_PREFIX.length) as PagesPanelAction, draft };
	}
}
