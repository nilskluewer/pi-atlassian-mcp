/**
 * Tool picker UI for /atlassian-tools.
 *
 * The shared `ctx.ui.select()` dialog cannot express a checkbox list: it stops
 * at the list ends instead of wrapping, and every toggle has to close and
 * re-open the dialog. With ~30 Atlassian tools that is painful, so the TUI path
 * uses pi's own `SelectList` - which scrolls, wraps around at both ends and
 * carries the standard theming - with checkbox labels layered on top.
 *
 * Non-TUI front ends (RPC) cannot render components, so they keep the
 * select-dialog loop.
 */

import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type PickerAction = "session" | "global" | "project";

export interface PickerItem {
	name: string;
	description?: string;
}

export interface PickerResult {
	action: PickerAction;
	selection: string[];
}

/** Tool rows shown at once; the list scrolls beyond that. */
const MAX_VISIBLE = 12;

const TOOL_PREFIX = "tool:";
const ACTION_PREFIX = "action:";

/** Only the parts of the extension context the picker needs. */
interface PickerCtx {
	mode: string;
	ui: {
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component) => Promise<T>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
	};
}

export async function pickTools(
	ctx: PickerCtx,
	items: PickerItem[],
	initialSelection: Iterable<string>,
	canSaveProject: boolean,
): Promise<PickerResult | undefined> {
	return ctx.mode === "tui"
		? pickWithComponent(ctx, items, initialSelection, canSaveProject)
		: pickWithSelectLoop(ctx, items, initialSelection, canSaveProject);
}

async function pickWithComponent(
	ctx: PickerCtx,
	items: PickerItem[],
	initialSelection: Iterable<string>,
	canSaveProject: boolean,
): Promise<PickerResult | undefined> {
	const result = await ctx.ui.custom<PickerResult | null>((tui, theme, _keybindings, done) => {
		const selection = new Set(initialSelection);

		const checkbox = (name: string) => `${selection.has(name) ? "[x]" : "[ ]"} ${name}`;
		const toolEntries = items.map((item) => ({
			value: `${TOOL_PREFIX}${item.name}`,
			label: checkbox(item.name),
			description: item.description,
		}));
		const actionEntries = [
			{ value: `${ACTION_PREFIX}session`, label: "▸ Apply to this session", description: "Active until this session ends" },
			{
				value: `${ACTION_PREFIX}global`,
				label: "▸ Save as global default",
				description: "Applied automatically in every new session",
			},
			...(canSaveProject
				? [
						{
							value: `${ACTION_PREFIX}project`,
							label: "▸ Save as project default",
							description: "Applied automatically in new sessions in this project",
						},
					]
				: []),
		];

		const title = new Text("", 0, 0);
		const hint = new Text("", 0, 0);
		const list = new SelectList([...toolEntries, ...actionEntries], MAX_VISIBLE, getSelectListTheme());

		const refreshChrome = () => {
			title.setText(theme.fg("accent", theme.bold(`Atlassian MCP tools - ${selection.size}/${items.length} selected`)));
			hint.setText(
				theme.fg("muted", "↑/↓ move (wraps)  ·  space or enter toggles  ·  a all/none  ·  enter on ▸ applies  ·  esc cancel"),
			);
		};
		refreshChrome();

		const toggle = (name: string) => {
			if (selection.has(name)) selection.delete(name);
			else selection.add(name);
			const entry = toolEntries.find((e) => e.value === `${TOOL_PREFIX}${name}`);
			if (entry) entry.label = checkbox(name);
			refreshChrome();
		};

		list.onSelect = (item) => {
			if (item.value.startsWith(TOOL_PREFIX)) {
				toggle(item.value.slice(TOOL_PREFIX.length));
				return;
			}
			done({ action: item.value.slice(ACTION_PREFIX.length) as PickerAction, selection: [...selection] });
		};
		list.onCancel = () => done(null);

		return {
			render(width: number): string[] {
				return [...title.render(width), ...list.render(width), ...hint.render(width)].map((line) =>
					truncateToWidth(line, width),
				);
			},
			handleInput(data: string): void {
				const selected = list.getSelectedItem();
				if (matchesKey(data, "space") && selected?.value.startsWith(TOOL_PREFIX)) {
					toggle(selected.value.slice(TOOL_PREFIX.length));
				} else if (data === "a") {
					if (selection.size === items.length) selection.clear();
					else for (const item of items) selection.add(item.name);
					for (const entry of toolEntries) entry.label = checkbox(entry.value.slice(TOOL_PREFIX.length));
					refreshChrome();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
			invalidate(): void {
				list.invalidate();
			},
		};
	});
	return result ?? undefined;
}

/** Select-dialog fallback for front ends without component support. */
async function pickWithSelectLoop(
	ctx: PickerCtx,
	items: PickerItem[],
	initialSelection: Iterable<string>,
	canSaveProject: boolean,
): Promise<PickerResult | undefined> {
	const selection = new Set(initialSelection);
	const APPLY = "Apply to this session only";
	const SAVE_GLOBAL = "Apply + save as global default";
	const SAVE_PROJECT = "Apply + save for this project";
	const CANCEL = "Cancel";

	while (true) {
		const labels = items.map(
			(t) => `${selection.has(t.name) ? "[x]" : "[ ]"} ${t.name}${t.description ? ` - ${t.description}` : ""}`,
		);
		const saveOptions = canSaveProject ? [SAVE_GLOBAL, SAVE_PROJECT] : [SAVE_GLOBAL];
		const choice = await ctx.ui.select(`Atlassian MCP tools - ${selection.size} selected:`, [
			...labels,
			APPLY,
			...saveOptions,
			CANCEL,
		]);
		if (!choice || choice === CANCEL) return undefined;
		if (choice === APPLY) return { action: "session", selection: [...selection] };
		if (choice === SAVE_GLOBAL) return { action: "global", selection: [...selection] };
		if (choice === SAVE_PROJECT) return { action: "project", selection: [...selection] };

		const idx = labels.indexOf(choice);
		if (idx < 0) continue;
		const name = items[idx].name;
		if (selection.has(name)) selection.delete(name);
		else selection.add(name);
	}
}
