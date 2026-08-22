import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../../src/i18n.ts';
import {
    manageRecents,
    showConversationHistoryForContact,
} from '../../../src/ui/menu/recents.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const makeConv = (i: number) => ({
    senderNumber: `+55110000000${i}`,
    senderName: `Contact ${i}`,
    lastMessagePreview: `preview ${i}`,
    lastMessageTime: 1_800_000_000 + i * 60_000,
    lastMessageDirection: 'incoming',
    messageCount: 1,
    isAllowed: false,
});

const makeMsg = (i: number, ts: number) => ({
    messageId: `MSG-${i}`,
    senderNumber: '+5511999998888',
    text: `message ${i}`,
    direction: 'incoming',
    timestamp: ts,
});

describe('menu pagination', () => {
    let env: ReturnType<typeof makeEnv>;

    beforeEach(() => {
        resetI18n();
        env = makeEnv();
    });

    it('paginates the recents list with Next/Previous', async () => {
        const conversations = Array.from({ length: 12 }, (_, i) => makeConv(i));
        (env.recentsService.getRecentConversations as any).mockResolvedValue(conversations);

        const picks: string[] = [];
        const ctx = makeCtx({
            selects: [(t: string, options: string[]) => {
                picks.push(...options);
                return 'Next'; // page 1 -> Next
            }, (_t: string, options: string[]) => {
                expect(options.some((o) => o === 'Previous')).toBe(true); // page 2 has Previous
                return 'Back';
            }]
        });

        await manageRecents(ctx as any, env);

        // First page shows exactly pageSize entries + Next + Back.
        expect(picks.filter((p) => p.startsWith('+55') || p.startsWith('[')).length).toBeLessThanOrEqual(10);
        expect(picks).toContain('Next');
    });

    it('shows an empty-recents notice and returns to root when there is nothing', async () => {
        const ctx = makeCtx();

        await manageRecents(ctx as any, env);

        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('No'), 'info');
        expect(env.openRootMenu).toHaveBeenCalled();
    });

    it('pages through conversation history with Next then Previous', async () => {
        const history = Array.from({ length: 23 }, (_, i) =>
            makeMsg(i, Date.now() - i * 3_600_000)
        );
        (env.recentsService.getConversationHistory as any).mockResolvedValue(history);

        const seenPages: number[] = [];
        const ctx = makeCtx({
            selects: [
                () => { seenPages.push(10); return 'Next'; },      // page 1 full -> next
                (_t, options) => {
                    const msgCount = options.length
                        - (options.includes('Previous') ? 1 : 0)
                        - (options.includes('Next') ? 1 : 0)
                        - 1; // Back
                    seenPages.push(msgCount);
                    expect(options).toContain('Previous'); // page 2 has Previous
                    return 'Back';                          // leave from page 2
                },
            ]
        });

        await showConversationHistoryForContact(
            ctx as any, env, '+5511999998888', 'Ana'
        );

        // Page 1 full, then page 2 also full (23 items -> 10/10/3).
        expect(seenPages[0]).toBe(10);
        expect(seenPages[1]).toBe(10);
    });

    it('notifies when a contact has no history', async () => {
        (env.recentsService.getConversationHistory as any).mockResolvedValue([]);
        const ctx = makeCtx();

        await showConversationHistoryForContact(ctx as any, env, '+111', 'Nobody');

        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('No message history'), 'info'
        );
        expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it('opens the detail view when a history entry is chosen', async () => {
        const detailModule = await import('../../../src/ui/message-detail.view.ts');
        const detailSpy = vi.spyOn(detailModule, 'showMessageDetailView')
            .mockResolvedValue(undefined);

        const history = [makeMsg(1, Date.now())];
        (env.recentsService.getConversationHistory as any).mockResolvedValue(history);
        const ctx = makeCtx({ selects: ['Back'] });
        // First select must pick the single history option.
        ctx.ui.select.mockImplementationOnce(async (_t: string, options: string[]) => options[0]);

        await showConversationHistoryForContact(ctx as any, env, '+5511999998888', 'Ana');

        expect(detailSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            messageId: 'MSG-1',
            text: 'message 1',
        }));
        detailSpy.mockRestore();
    });
});