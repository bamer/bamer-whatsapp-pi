import {
	Input,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	matchesKey,
	Key,
} from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";

/** Build a SelectListTheme from a Pi Theme instance. */
export function buildSelectListTheme(theme: any): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

/**
 * SearchableContactList — Input + SelectList composite.
 * Type to filter, arrows to navigate, Enter to select, Esc to cancel.
 */
export class SearchableContactList implements Component, Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private _focused = false;
	private allItems: SelectItem[];
	private filteredItems: SelectItem[];

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;

	constructor(items: SelectItem[], theme: any, maxVisible = 20) {
		this.allItems = items;
		this.filteredItems = items;
		this.searchInput = new Input();
		this.selectList = new SelectList(items, maxVisible, buildSelectListTheme(theme));

		// Intercept Input's onSubmit (Enter when focused on input) to forward to SelectList
		this.searchInput.onSubmit = () => {
			this.selectList.handleInput("\r"); // Enter key
		};
	}

	// Focusable — propagate to child Input for IME cursor positioning
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	/** Update the filter when search text changes — searches label, description, AND value. */
	private updateFilter(): void {
		const filter = this.searchInput.getValue().toLowerCase().trim();
		if (!filter) {
			this.filteredItems = this.allItems;
		} else {
			this.filteredItems = this.allItems.filter((item) => {
				const val = (item.value || "").toLowerCase();
				const label = (item.label || "").toLowerCase();
				const desc = (item.description || "").toLowerCase();
				return val.includes(filter) || label.includes(filter) || desc.includes(filter);
			});
		}
		// Pass pre-filtered items to SelectList (which uses startsWith on value)
		// We set filter to empty so SelectList shows all our pre-filtered items
		this.selectList.setFilter("");
		// Replace the internal filteredItems with our custom filtered list
		// (filteredItems is private in TS types but public in JS implementation)
		(this.selectList as any).filteredItems = this.filteredItems;
		this.selectList.setSelectedIndex(0);
	}

	handleInput(data: string): void {
		// Navigation keys → SelectList
		if (
			matchesKey(data, Key.up) ||
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.selectList.handleInput(data);
			return;
		}
		// Everything else → Input (typing, backspace, etc.)
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (before !== this.searchInput.getValue()) {
			this.updateFilter();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const query = this.searchInput.getValue();
		lines.push(`Search: ${query}`);
		lines.push("─".repeat(Math.min(width, 60)));
		lines.push(...this.selectList.render(width));
		return lines;
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.selectList.invalidate();
	}
}