import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuHandler } from '../../src/ui/menu.handler.js';
import type { RecentConversationSummary } from '../../src/models/whatsapp.types.js';

vi.mock('qrcode-terminal', () => ({ generate: vi.fn() }));

vi.mock('../../src/ui/message-detail.view.js', () => ({ showMessageDetailView: vi.fn() }));
vi.mock('../../src/ui/message-reply.view.js', () => ({ showMessageReplyView: vi.fn() }));

vi.mock('os', () => ({ homedir: () => 'C:\\Users\\test' }));
vi.mock('fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('not found')),
    writeFile: vi.fn().mockResolvedValue(undefined)
}));

function makeConversation(overrides: Partial<RecentConversationSummary>): RecentConversationSummary {
    return {
        senderNumber: '+5511000000001',
        senderName: 'Test',
        lastMessagePreview: 'hello',
        lastMessageTime: new Date('2024-01-15T10:30:00.000Z').getTime(),
        lastMessageDirection: 'incoming',
        messageCount: 1,
        isAllowed: false,
        ...overrides
    };
}

describe('MenuHandler — recents grouping helpers', () => {
    let handler: MenuHandler;
    const mockWhatsAppService = {} as any;
    const mockSessionManager = {
        isConversationAllowed: vi.fn().mockReturnValue(false),
        getAllowedContact: vi.fn().mockReturnValue(undefined),
        getAllowedGroup: vi.fn().mockReturnValue(undefined),
        addNumber: vi.fn().mockResolvedValue(undefined),
        addAllowedGroup: vi.fn().mockResolvedValue(undefined),
        isGroupJid: vi.fn().mockReturnValue(false),
        isAllowedUpdateTarget: vi.fn().mockResolvedValue(false),
        getAssistantName: vi.fn().mockReturnValue('Agent Pi')
    } as any;
    const mockRecentsService = {
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        getRecentConversations: vi.fn().mockResolvedValue([]),
        getConversationHistory: vi.fn().mockResolvedValue([]),
        recordMessage: vi.fn().mockResolvedValue(undefined)
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = new MenuHandler(mockWhatsAppService, mockSessionManager, mockRecentsService);
    });

    const groupFn = (convs: RecentConversationSummary[]) =>
        (handler as any).groupRecentConversations(convs) as Array<{
            conversations: RecentConversationSummary[];
            sharedPreview: string;
            sharedTime: number;
        }>;

    const keyFn = (conv: RecentConversationSummary) =>
        (handler as any).getRecentsGroupKey(conv) as string;

    const fmtFn = (entry: { conversations: RecentConversationSummary[]; sharedPreview: string; sharedTime: number }) =>
        (handler as any).formatGroupedRecentOption(entry) as string;

    const fmtSingleFn = (conv: RecentConversationSummary) =>
        (handler as any).formatRecentConversationOption(conv) as string;

    describe('getRecentsGroupKey', () => {
        it('produces the same key for two timestamps in the same minute', () => {
            const t1 = new Date('2024-01-15T10:30:05.000Z').getTime();
            const t2 = new Date('2024-01-15T10:30:55.000Z').getTime();
            const c1 = makeConversation({ lastMessagePreview: 'hello', lastMessageTime: t1 });
            const c2 = makeConversation({ lastMessagePreview: 'hello', lastMessageTime: t2 });
            expect(keyFn(c1)).toBe(keyFn(c2));
        });

        it('produces different keys for timestamps in different minutes', () => {
            const t1 = new Date('2024-01-15T10:30:00.000Z').getTime();
            const t2 = new Date('2024-01-15T10:31:00.000Z').getTime();
            const c1 = makeConversation({ lastMessagePreview: 'hello', lastMessageTime: t1 });
            const c2 = makeConversation({ lastMessagePreview: 'hello', lastMessageTime: t2 });
            expect(keyFn(c1)).not.toBe(keyFn(c2));
        });

        it('produces different keys for different preview texts at the same minute', () => {
            const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
            const c1 = makeConversation({ lastMessagePreview: 'hello', lastMessageTime: ts });
            const c2 = makeConversation({ lastMessagePreview: 'goodbye', lastMessageTime: ts });
            expect(keyFn(c1)).not.toBe(keyFn(c2));
        });

        it('produces a unique key for outgoing conversations regardless of preview or time', () => {
            const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hi', lastMessageTime: ts, lastMessageDirection: 'outgoing' });
            const c2 = makeConversation({ senderNumber: '+2', lastMessagePreview: 'hi', lastMessageTime: ts, lastMessageDirection: 'outgoing' });
            expect(keyFn(c1)).not.toBe(keyFn(c2));
        });

        it('does not group an outgoing conversation with an incoming conversation sharing the same preview and minute', () => {
            const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
            const incoming = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hi', lastMessageTime: ts, lastMessageDirection: 'incoming' });
            const outgoing = makeConversation({ senderNumber: '+2', lastMessagePreview: 'hi', lastMessageTime: ts, lastMessageDirection: 'outgoing' });
            expect(keyFn(incoming)).not.toBe(keyFn(outgoing));
        });
    });

    describe('groupRecentConversations — US1', () => {
        it('groups two conversations with same preview and same minute into one entry', () => {
            const ts1 = new Date('2024-01-15T10:30:05.000Z').getTime();
            const ts2 = new Date('2024-01-15T10:30:50.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hello', lastMessageTime: ts1 });
            const c2 = makeConversation({ senderNumber: '+2', lastMessagePreview: 'hello', lastMessageTime: ts2 });

            const result = groupFn([c1, c2]);

            expect(result).toHaveLength(1);
            expect(result[0].conversations).toHaveLength(2);
            expect(result[0].sharedPreview).toBe('hello');
        });

        it('does not group two conversations with same preview but different minutes', () => {
            const ts1 = new Date('2024-01-15T10:30:00.000Z').getTime();
            const ts2 = new Date('2024-01-15T10:31:00.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hello', lastMessageTime: ts1 });
            const c2 = makeConversation({ senderNumber: '+2', lastMessagePreview: 'hello', lastMessageTime: ts2 });

            const result = groupFn([c1, c2]);

            expect(result).toHaveLength(2);
        });

        it('does not group two conversations with same minute but different previews', () => {
            const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hello', lastMessageTime: ts });
            const c2 = makeConversation({ senderNumber: '+2', lastMessagePreview: 'goodbye', lastMessageTime: ts });

            const result = groupFn([c1, c2]);

            expect(result).toHaveLength(2);
        });

        it('preserves conversation order within a group', () => {
            const ts1 = new Date('2024-01-15T10:30:05.000Z').getTime();
            const ts2 = new Date('2024-01-15T10:30:40.000Z').getTime();
            const ts3 = new Date('2024-01-15T10:30:55.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hi', lastMessageTime: ts1 });
            const c2 = makeConversation({ senderNumber: '+2', lastMessagePreview: 'hi', lastMessageTime: ts2 });
            const c3 = makeConversation({ senderNumber: '+3', lastMessagePreview: 'hi', lastMessageTime: ts3 });

            const result = groupFn([c1, c2, c3]);

            expect(result).toHaveLength(1);
            expect(result[0].conversations[0].senderNumber).toBe('+1');
            expect(result[0].conversations[1].senderNumber).toBe('+2');
            expect(result[0].conversations[2].senderNumber).toBe('+3');
        });

        it('returns empty array for empty input', () => {
            expect(groupFn([])).toHaveLength(0);
        });

        it('returns single-entry group unchanged for a solo conversation', () => {
            const c = makeConversation({ senderNumber: '+1', lastMessagePreview: 'hello' });
            const result = groupFn([c]);
            expect(result).toHaveLength(1);
            expect(result[0].conversations).toHaveLength(1);
        });
    });

    describe('formatGroupedRecentOption — US1 + US2', () => {
        it('delegates to formatRecentConversationOption for a single-member group', () => {
            const conv = makeConversation({ senderNumber: '+1', senderName: 'Alice' });
            const entry = { conversations: [conv], sharedPreview: conv.lastMessagePreview, sharedTime: conv.lastMessageTime };

            expect(fmtFn(entry)).toBe(fmtSingleFn(conv));
        });

        it('shows per-contact identifiers for a multi-member group (nameless → parens, named → brackets)', () => {
            const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
            const c1 = makeConversation({ senderNumber: '+1', senderName: undefined, lastMessagePreview: 'hey', lastMessageTime: ts });
            const c2 = makeConversation({ senderNumber: '+2', senderName: 'Alice', lastMessagePreview: 'hey', lastMessageTime: ts });
            const entry = { conversations: [c1, c2], sharedPreview: 'hey', sharedTime: ts };

            const label = fmtFn(entry);

            expect(label).toContain('(+1)');
            expect(label).toContain('[+2] Alice');
            expect(label).toContain('hey');
            expect(label).not.toContain('contacts');
        });

        it('does not show count label for a single-member group', () => {
            const conv = makeConversation({ senderNumber: '+1' });
            const entry = { conversations: [conv], sharedPreview: conv.lastMessagePreview, sharedTime: conv.lastMessageTime };

            expect(fmtFn(entry)).not.toContain('contacts');
        });
    });

    describe('JID allow-contact flow — US3', () => {
        it('passes senderNumber unmodified to sessionManager.addNumber when allowing from grouped sub-list', async () => {
            const senderNumber = '+5511999998888';
            const conv = makeConversation({ senderNumber, senderName: 'Alice', isAllowed: false });

            const allowLabel = 'Allow Contact';
            const backLabel = 'Back';

            const mockCtx = {
                ui: {
                    select: vi.fn()
                        .mockResolvedValueOnce(allowLabel)
                        .mockResolvedValueOnce(backLabel),
                    notify: vi.fn()
                }
            } as any;

            mockSessionManager.isConversationAllowed.mockReturnValue(false);
            mockSessionManager.getAllowedContact.mockReturnValue(undefined);

            vi.spyOn(handler as any, 'manageRecents').mockResolvedValue(undefined);

            await (handler as any).manageRecentConversation(mockCtx, conv);

            expect(mockSessionManager.addNumber).toHaveBeenCalledWith(senderNumber, 'Alice');
        });
    });
});
