import { describe, expect, it, vi } from 'vitest';
import { SearchableContactList, buildSelectListTheme } from '../../src/ui/searchable-list.ts';

const fakeTheme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text
};

const ITEMS = [
    { value: 'ana@s.whatsapp.net', label: 'Ana', description: '+5511999998888' },
    { value: 'bruno@lid', label: 'Bruno', description: 'bruno@lid' },
    { value: 'carla@s.whatsapp.net', label: 'Carla Silva', description: '+5522988887777' }
];

const makeList = (items = ITEMS) => new SearchableContactList(items, fakeTheme);

describe('buildSelectListTheme', () => {
    it('maps every theme role through theme.fg', () => {
        const theme = buildSelectListTheme(fakeTheme);
        expect(theme.selectedPrefix('x')).toBe('x');
        expect(theme.selectedText('x')).toBe('x');
        expect(theme.description('x')).toBe('x');
        expect(theme.scrollInfo('x')).toBe('x');
        expect(theme.noMatch('x')).toBe('x');
    });
});

describe('SearchableContactList', () => {
    it('renders the search line, separator and item list', () => {
        const list = makeList();
        const lines = list.render(60);

        expect(lines[0]).toBe('Search: ');
        expect(lines[1]).toBe('─'.repeat(60));
        expect(lines.join('\n')).toContain('Ana');
        expect(lines.length).toBeGreaterThan(3);
    });

    it('propagates focus to the inner input', () => {
        const list = makeList();
        expect(list.focused).toBe(false);
        list.focused = true;
        expect(list.focused).toBe(true);
    });

    it('invalidates both children without throwing', () => {
        const list = makeList();
        expect(() => list.invalidate()).not.toThrow();
    });

    it('filters by label case-insensitively while typing', () => {
        const list = makeList();
        for (const ch of 'ANA') list.handleInput(ch);

        const rendered = list.render(60).join('\n');
        expect(rendered).toContain('Ana');
        expect(rendered).not.toContain('Bruno');
        expect(rendered).not.toContain('Carla');
    });

    it('filters by value (JID) and by description (phone)', () => {
        const byValue = makeList();
        for (const ch of '@lid') byValue.handleInput(ch);
        expect(byValue.render(60).join('\n')).toContain('Bruno');
        expect(byValue.render(60).join('\n')).not.toContain('Ana');

        const byDesc = makeList();
        for (const ch of '98888') byDesc.handleInput(ch);
        expect(byDesc.render(60).join('\n')).toContain('Carla');
        expect(byDesc.render(60).join('\n')).not.toContain('Bruno');
    });

    it('shows all items again when the filter is cleared with backspace', () => {
        const list = makeList();
        for (const ch of 'AN') list.handleInput(ch);
        list.handleInput('\x7f');
        list.handleInput('\x7f');

        const rendered = list.render(60).join('\n');
        expect(rendered).toContain('Ana');
        expect(rendered).toContain('Bruno');
        expect(rendered).toContain('Carla');
    });

    it('forwards Enter to the inner SelectList which fires onSelect', () => {
        const list = makeList();
        const onSelect = vi.fn();
        const onCancel = vi.fn();
        list.onSelect = onSelect;
        list.onCancel = onCancel;

        list.handleInput('\r');

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: 'Ana' }));
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('fires onSelect for the item matching the current filter', () => {
        const list = makeList();
        const onSelect = vi.fn();
        list.onSelect = onSelect;

        for (const ch of 'carla') list.handleInput(ch);
        list.handleInput('\r');

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: 'Carla Silva' }));
    });

    it('fires onCancel on Escape', () => {
        const list = makeList();
        const onSelect = vi.fn();
        const onCancel = vi.fn();
        list.onSelect = onSelect;
        list.onCancel = onCancel;

        list.handleInput('\x1b');

        expect(onCancel).toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('supports callbacks assigned after construction (late wiring)', () => {
        const list = makeList();
        const onSelect = vi.fn();

        list.handleInput('\x1b[B'); // navigate before any callback exists
        list.onSelect = onSelect;   // consumer wires later, like menu.handler does
        list.handleInput('\r');

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: 'Bruno' }));
    });

    it('navigates with arrow keys and keeps filter untouched', () => {
        const list = makeList();
        const onSelect = vi.fn();
        list.onSelect = onSelect;

        list.handleInput('\x1b[B'); // -> Bruno
        list.handleInput('\x1b[A');   // -> Ana
        list.handleInput('\r');

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: 'Ana' }));
    });

    it('tolerates items with missing optional fields when filtering', () => {
        const sparse = [{ value: '' }, { value: 'x@lid' }] as any;
        const list = new SearchableContactList(sparse, fakeTheme);
        for (const ch of 'x') list.handleInput(ch);

        const rendered = list.render(60).join('\n');
        expect(rendered).toContain('x@lid');
    });
});
