import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../src/i18n.ts';

const mocks = vi.hoisted(() => {
    const createSessionManager = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        isRegistered: vi.fn().mockResolvedValue(false),
        setStatus: vi.fn().mockResolvedValue(undefined),
        addNumber: vi.fn().mockResolvedValue(undefined),
        addAllowedGroup: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue('connected'),
        getAllowList: vi.fn().mockReturnValue([]),
        getAllowedGroups: vi.fn().mockReturnValue([]),
        getUpdateList: vi.fn().mockReturnValue([]),
        getAutoConnect: vi.fn().mockReturnValue(false),
        isAllowedUpdateTarget: vi.fn().mockResolvedValue(true),
        setGroupJidForAuth: vi.fn()
    });

    const createWhatsAppService = () => ({
        setVerboseMode: vi.fn(),
        setStatusCallback: vi.fn(),
        setIncomingMessageRecorder: vi.fn(),
        setMessageCallback: vi.fn(),
        setGroupBinding: vi.fn(),
        getBoundGroupJid: vi.fn().mockReturnValue(null),
        getStatus: vi.fn().mockReturnValue('connected'),
        isVerbose: vi.fn().mockReturnValue(false),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'MSG123', attempts: 1 }),
        resolveOutboundRecipientJid: vi.fn((recipient: string) => recipient),
        getLastRemoteJid: vi.fn().mockReturnValue('5511999998888@s.whatsapp.net'),
        getOperatorJid: vi.fn().mockReturnValue(''),
        getSocket: vi.fn().mockReturnValue(null),
        getContactsService: vi.fn().mockReturnValue({
            fetchContactsFromGroups: vi.fn(), reclassifyContacts: vi.fn()
        }),
        sendMediaMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'MEDIA1' }),
        addGroupParticipants: vi.fn().mockResolvedValue({ success: true }),
        removeGroupParticipants: vi.fn().mockResolvedValue({ success: true }),
        markRead: vi.fn(),
        sendPresence: vi.fn().mockResolvedValue(undefined)
    });

    const createRecentsService = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        recordMessage: vi.fn().mockResolvedValue(undefined),
        getRecentConversations: vi.fn().mockResolvedValue([
            { senderNumber: '+111@s.whatsapp.net', lastMessageDirection: 'incoming', isAllowed: true },
            { senderNumber: '+222@s.whatsapp.net', lastMessageDirection: 'outgoing', isAllowed: false },
        ])
    });

    const createMenuHandler = () => ({ handleCommand: vi.fn().mockResolvedValue(undefined) });
    const createIncomingMediaService = () => ({
        process: vi.fn().mockResolvedValue({ text: 'hello from whatsapp' })
    });

    return {
        sessionManager: createSessionManager(),
        whatsappService: createWhatsAppService(),
        recentsService: createRecentsService(),
        menuHandler: createMenuHandler(),
        incomingMediaService: createIncomingMediaService(),
        extractIncomingText: vi.fn().mockReturnValue({ kind: 'text', text: 'hello from whatsapp' }),
        reset() {
            this.sessionManager = createSessionManager();
            this.whatsappService = createWhatsAppService();
            this.recentsService = createRecentsService();
            this.menuHandler = createMenuHandler();
            this.incomingMediaService = createIncomingMediaService();
            this.extractIncomingText = vi.fn().mockReturnValue({ kind: 'text', text: 'hello from whatsapp' });
        }
    };
});

vi.mock('../../src/services/session.manager.ts', () => ({
    SessionManager: Object.assign(vi.fn(function () { return mocks.sessionManager; }), {
        isGroupJid: (jid: string) => jid.endsWith('@g.us')
    })
}));
vi.mock('../../src/services/whatsapp.service.ts', () => ({
    WhatsAppService: vi.fn(function () { return mocks.whatsappService; })
}));
vi.mock('../../src/services/recents.service.ts', () => ({
    RecentsService: vi.fn(function () { return mocks.recentsService; })
}));
vi.mock('../../src/services/audio.service.ts', () => ({
    AudioService: vi.fn(function () { return {}; })
}));
vi.mock('../../src/ui/menu.handler.ts', () => ({
    MenuHandler: vi.fn(function () { return mocks.menuHandler; })
}));
vi.mock('../../src/services/incoming-message.resolver.ts', () => ({
    extractIncomingText: (...args: unknown[]) => mocks.extractIncomingText(...args)
}));
vi.mock('../../src/services/incoming-media.service.ts', () => ({
    IncomingMediaService: vi.fn(function () { return mocks.incomingMediaService; })
}));

type PiHandler = (event: any, ctx: any) => Promise<void>;

const createMockPi = () => {
    const handlers = new Map<string, PiHandler>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    return {
        handlers,
        tools,
        commands,
        registerFlag: vi.fn(),
        on: vi.fn((name: string, handler: PiHandler) => handlers.set(name, handler)),
        registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
        registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
        getFlag: vi.fn().mockReturnValue(false),
        appendEntry: vi.fn(),
        exec: vi.fn().mockResolvedValue({ code: 0 }),
        sendUserMessage: vi.fn()
    };
};

const loadExtension = async () => {
    vi.resetModules();
    const module = await import('../../whatsapp-pi.ts');
    return module.default;
};

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const parseContent = (result: any) => JSON.parse(result.content[0].text);

describe('whatsapp-pi tools', () => {
    let pi: ReturnType<typeof createMockPi>;

    beforeEach(async () => {
        resetI18n();
        vi.stubEnv('WHATSAPP_PI_LOCALE', '');
        mocks.reset();
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const registerExtension = await loadExtension();
        pi = createMockPi();
        registerExtension(pi as any);
    });

    describe('send_wa_message', () => {
        it('errors when no JID and no active conversation exist', async () => {
            mocks.whatsappService.getLastRemoteJid.mockReturnValue(null);
            mocks.whatsappService.getOperatorJid.mockReturnValue('');

            const tool = pi.tools.get('send_wa_message');
            const result = await tool.execute('tc', { message: 'hi' });

            expect(result.isError).toBe(true);
            expect(parseContent(result)).toEqual({
                success: false,
                error: 'No JID provided and no active conversation to reply to',
                attempts: 0,
            });
        });

        it('errors when the service is disconnected', async () => {
            mocks.whatsappService.getStatus.mockReturnValue('disconnected');

            const result = await pi.tools.get('send_wa_message').execute('tc', {
                jid: '+111@s.whatsapp.net',
                message: 'hi'
            });

            expect(result.isError).toBe(true);
            expect(parseContent(result).error).toBe(t('tool.error.notConnected'));
        });

        it('blocks recipients outside the update list', async () => {
            mocks.sessionManager.getUpdateList.mockReturnValue([{ number: '+approved' }]);
            mocks.sessionManager.isAllowedUpdateTarget.mockResolvedValue(false);

            const result = await pi.tools.get('send_wa_message').execute('tc', {
                jid: '+stranger@s.whatsapp.net',
                message: 'spam'
            });

            expect(result.isError).toBe(true);
            const parsed = parseContent(result);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('not in the update list');
            expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
        });

        it('sends fire-and-forget to an approved target and records a pending message', async () => {
            mocks.sessionManager.isAllowedUpdateTarget.mockResolvedValue(true);
            // Deferred send: the tool must return BEFORE the send resolves.
            let releaseSend: (r: any) => void = () => {};
            const sendPromise = new Promise<any>((resolve) => { releaseSend = resolve; });
            mocks.whatsappService.sendMessage.mockReturnValue(sendPromise);

            const execution = pi.tools.get('send_wa_message').execute('tc', {
                jid: '5511999998888@s.whatsapp.net',
                message: 'bonjour'
            });

            const result = await execution; // resolves without waiting for the send

            // Immediate optimistic response — the deferred send has NOT resolved.
            expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
                '5511999998888@s.whatsapp.net', 'bonjour'
            );
            expect(result.isError).toBe(false);
            const parsed = parseContent(result);
            expect(parsed).toEqual({ success: true, pending: true, messageId: expect.any(String) });

            releaseSend({ success: true, messageId: 'MSG-LATER' });
            await flushAsync();

            expect(mocks.recentsService.recordMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'bonjour',
                    direction: 'outgoing',
                    senderNumber: '+5511999998888'
                })
            );
        });

        it('lets messages to the operator bypass the update-list filter', async () => {
            mocks.whatsappService.getOperatorJid.mockReturnValue('33684136128@s.whatsapp.net');
            mocks.sessionManager.getUpdateList.mockReturnValue([]);
            mocks.sessionManager.isAllowedUpdateTarget.mockResolvedValue(false);

            const result = await pi.tools.get('send_wa_message').execute('tc', {
                jid: '33684136128@s.whatsapp.net',
                message: 'note to self'
            });

            expect(result.isError).toBe(false);
            await flushAsync();
            expect(mocks.whatsappService.sendMessage).toHaveBeenCalled();
        });

        it('falls back to recipient_jid then lastRemoteJid', async () => {
            mocks.sessionManager.isAllowedUpdateTarget.mockResolvedValue(true);

            await pi.tools.get('send_wa_message').execute('tc', {
                recipient_jid: '5522988887777@s.whatsapp.net',
                message: 'alt key'
            });
            await flushAsync();
            expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
                '5522988887777@s.whatsapp.net', 'alt key'
            );

            mocks.whatsappService.getLastRemoteJid.mockReturnValue('+last@s.whatsapp.net');
            await pi.tools.get('send_wa_message').execute('tc', { message: 'reply mode' });
            await flushAsync();
            expect(mocks.whatsappService.sendMessage).toHaveBeenLastCalledWith(
                '+last@s.whatsapp.net', 'reply mode'
            );
        });
    });

    describe('send_reaction', () => {
        it('errors when there is no socket', async () => {
            const result = await pi.tools.get('send_reaction').execute('tc', {
                jid: '+111@s.whatsapp.net', messageId: 'M1', emoji: '👍'
            });

            expect(result.isError).toBe(true);
            expect(parseContent(result).success).toBe(false);
        });

        it('sends the reaction through the socket and reports success', async () => {
            const socket = { sendMessage: vi.fn().mockResolvedValue({ key: { id: 'R1' } }) };
            mocks.whatsappService.getSocket.mockReturnValue(socket);

            const result = await pi.tools.get('send_reaction').execute('tc', {
                jid: '+111@s.whatsapp.net', messageId: 'M1', emoji: '❤️'
            });

            expect(result.isError).toBe(false);
            expect(parseContent(result)).toEqual({ success: true, messageId: 'R1', error: undefined });
            expect(socket.sendMessage).toHaveBeenCalledWith('+111@s.whatsapp.net', expect.objectContaining({
                react: expect.objectContaining({
                    text: '❤️',
                    key: { remoteJid: '+111@s.whatsapp.net', id: 'M1', fromMe: false }
                })
            }));
        });

        it('reports failure when the socket rejects', async () => {
            const socket = { sendMessage: vi.fn().mockRejectedValue(new Error('stale')) };
            mocks.whatsappService.getSocket.mockReturnValue(socket);

            const result = await pi.tools.get('send_reaction').execute('tc', {
                jid: '+111@s.whatsapp.net', messageId: 'M1', emoji: '👍'
            });

            expect(result.isError).toBe(true);
            expect(parseContent(result).success).toBe(false);
        });
    });

    describe('send_wa_media', () => {
        it.each(['image', 'video', 'document'] as const)('delegates %s sends to the service', async (type) => {
            const result = await pi.tools.get('send_wa_media').execute('tc', {
                jid: '5511999998888@s.whatsapp.net',
                mediaPath: '/tmp/file.bin',
                type,
                caption: 'cap'
            });

            expect(result.isError).toBe(false);
            expect(parseContent(result)).toEqual({ success: true, messageId: 'MEDIA1', error: undefined });
            expect(mocks.whatsappService.sendMediaMessage).toHaveBeenCalledWith(
                '5511999998888@s.whatsapp.net', '/tmp/file.bin', type, 'cap'
            );
        });

        it('flags failures with isError', async () => {
            mocks.whatsappService.sendMediaMessage.mockResolvedValue({
                success: false, error: 'file not found'
            });

            const result = await pi.tools.get('send_wa_media').execute('tc', {
                jid: '+111@s.whatsapp.net', mediaPath: '/nope.jpg', type: 'image'
            });

            expect(result.isError).toBe(true);
            expect(parseContent(result)).toEqual({ success: false, messageId: undefined, error: 'file not found' });
        });
    });

    describe.each([
        ['add_wa_group_participant', 'addGroupParticipants'],
        ['remove_wa_group_participant', 'removeGroupParticipants'],
    ])('%s', (toolName, serviceMethod) => {
        it('delegates to the service and returns success', async () => {
            const result = await pi.tools.get(toolName).execute('tc', {
                groupJid: '120363409409770410@g.us',
                participantJids: ['+33684136128']
            });

            expect(result.isError).toBe(false);
            expect(parseContent(result)).toEqual({ success: true });
            expect(mocks.whatsappService[serviceMethod]).toHaveBeenCalledWith(
                '120363409409770410@g.us', ['+33684136128']
            );
        });

        it('returns isError when the service fails', async () => {
            mocks.whatsappService[serviceMethod].mockResolvedValue({
                success: false, error: 'not an admin'
            });

            const result = await pi.tools.get(toolName).execute('tc', {
                groupJid: '120363409409770410@g.us',
                participantJids: ['+33684136128']
            });

            expect(result.isError).toBe(true);
            expect(parseContent(result)).toEqual({ success: false, error: 'not an admin' });
        });
    });

    describe('list_wa_conversations', () => {
        it('filters by onlyIncoming / onlyAllowed and applies the limit', async () => {
            const result = await pi.tools.get('list_wa_conversations').execute('tc', {
                onlyIncoming: true,
                onlyAllowed: true,
                limit: 5
            });

            const parsed = parseContent(result);
            expect(parsed.success).toBe(true);
            expect(parsed.count).toBe(1); // only +111 matches both filters
            expect(parsed.conversations[0].senderNumber).toBe('+111@s.whatsapp.net');
        });

        it('returns everything without filters', async () => {
            const parsed = parseContent(
                await pi.tools.get('list_wa_conversations').execute('tc', {})
            );
            expect(parsed.count).toBe(2);
        });
    });

    it('registers all six WhatsApp tools up-front', () => {
        for (const name of [
            'send_wa_message',
            'send_reaction',
            'send_wa_media',
            'add_wa_group_participant',
            'remove_wa_group_participant',
            'list_wa_conversations',
        ]) {
            expect(pi.tools.has(name)).toBe(true);
        }
    });
});
