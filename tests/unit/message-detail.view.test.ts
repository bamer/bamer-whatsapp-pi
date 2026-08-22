import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';
import { MessageDetailView } from '../../src/ui/message-detail.view.ts';

describe('MessageDetailView', () => {
    beforeEach(() => {
        resetI18n();
    });

    it('renders full message context and content', () => {
        const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
        const view = new MessageDetailView({
            title: 'Message • Ana',
            messageId: 'MSG1',
            senderNumber: '+5511999998888',
            senderName: 'Ana',
            text: 'First line\nSecond line with emojis 🚀',
            direction: 'incoming',
            timestamp: new Date(2026, 3, 20, 10, 15, 30).getTime(),
            onClose: vi.fn(),
            onReply: vi.fn()
        });

        const output = view.render(80).join('\n').replace(ansiPattern, '');

        expect(output).toContain('╭');
        expect(output).toContain('╰');
        expect(output).not.toContain('Message • Ana');
        expect(output).toContain('Message ID: MSG1');
        expect(output).toContain('From: Ana (+5511999998888)');
        expect(output).toContain('Direction: Received');
        expect(output).toContain('First line');
        expect(output).toContain('Second');
        expect(output).toContain('line with');
        expect(output).toContain('emojis 🚀');
        expect(output).toContain('Press R to reply');
    });

    it('opens reply flow when the user presses R', () => {
        const onClose = vi.fn();
        const onReply = vi.fn();
        const view = new MessageDetailView({
            title: 'Message • Ana',
            messageId: 'MSG1',
            senderNumber: '+5511999998888',
            text: 'hello',
            direction: 'incoming',
            timestamp: Date.now(),
            onClose,
            onReply
        });

        view.handleInput('r');

        expect(onReply).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes when the user presses Enter or Escape', () => {
        const onClose = vi.fn();
        const view = new MessageDetailView({
            title: 'Message • Ana',
            messageId: 'MSG1',
            senderNumber: '+5511999998888',
            text: 'hello',
            direction: 'incoming',
            timestamp: Date.now(),
            onClose
        });

        view.handleInput('escape');
        view.handleInput('enter');

        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('renders the sender name with number when available', () => {
        const view = new MessageDetailView({
            title: 'Message • Ana',
            messageId: 'MSG1',
            senderNumber: '+5511999998888',
            senderName: 'Ana',
            text: 'hello',
            direction: 'incoming',
            timestamp: Date.now(),
            onClose: vi.fn()
        });

        const rendered = view.render(80).join('\n');
        expect(rendered).toContain('Ana (+5511999998888)');
    });

    it('marks outgoing messages with the assistant name', () => {
        const view = new MessageDetailView({
            title: 'Message',
            messageId: 'MSG2',
            senderNumber: '+5511999998888',
            text: 'hello',
            direction: 'outgoing',
            assistantName: 'Agent Pi',
            timestamp: Date.now(),
            onClose: vi.fn()
        });

        expect(view.render(80).join('\n')).toContain('Agent Pi');
    });

    it('shows a fallback for empty message bodies and replies on R', async () => {
        const onReply = vi.fn().mockResolvedValue(undefined);
        const view = new MessageDetailView({
            title: 'Message',
            messageId: 'MSG3',
            senderNumber: '+5511999998888',
            text: '',
            direction: 'incoming',
            timestamp: Date.now(),
            onClose: vi.fn(),
            onReply
        });

        const rendered = view.render(80).join('\n');
        expect(rendered).not.toContain('│  │');

        view.handleInput('r');
        await Promise.resolve();
        expect(onReply).toHaveBeenCalledTimes(1);
    });

    it('wires close/reply through ctx.ui.custom', async () => {
        const { showMessageDetailView } = await import('../../src/ui/message-detail.view.ts');

        let capturedFactory: any;
        const ctx = {
            ui: {
                custom: vi.fn(async (factory: any) => {
                    capturedFactory = factory;
                    return undefined;
                })
            }
        };

        await showMessageDetailView(ctx as any, {
            title: 'T',
            messageId: 'M',
            senderNumber: '+111',
            text: 'x',
            direction: 'incoming',
            timestamp: 0
        });

        // Drive both exits from inside the factory.
        let result: string | undefined;
        const done = (v?: string) => { result = v; };
        const view = capturedFactory(null, null, null, done);
        expect(view).toBeInstanceOf(MessageDetailView);

        view.handleInput('r');
        expect(result).toBe('reply');

        result = undefined;
        view.handleInput('escape');
        expect(result).toBeUndefined();
    });
});
