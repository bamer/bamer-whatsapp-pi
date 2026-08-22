import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../src/i18n.ts';

const mocks = vi.hoisted(() => {
    const createSessionManager = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        isRegistered: vi.fn().mockResolvedValue(true),
        setStatus: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue('connected'),
        addNumber: vi.fn().mockResolvedValue(undefined),
        addAllowedGroup: vi.fn().mockResolvedValue(undefined),
        getAllowList: vi.fn().mockReturnValue([]),
        getAllowedGroups: vi.fn().mockReturnValue([]),
        getUpdateList: vi.fn().mockReturnValue([]),
        getAutoConnect: vi.fn().mockReturnValue(false),
        isAllowedUpdateTarget: vi.fn().mockResolvedValue(false),
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
        resolveOutboundRecipientJid: vi.fn((r: string) => r),
        getLastRemoteJid: vi.fn().mockReturnValue(null),
        getOperatorJid: vi.fn().mockReturnValue(''),
        getSocket: vi.fn().mockReturnValue(null),
        getContactsService: vi.fn().mockReturnValue({ getContact: vi.fn() }),
        sendMediaMessage: vi.fn(),
        addGroupParticipants: vi.fn(),
        removeGroupParticipants: vi.fn(),
        markRead: vi.fn(),
        sendPresence: vi.fn().mockResolvedValue(undefined)
    });

    const createRecentsService = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        recordMessage: vi.fn().mockResolvedValue(undefined),
        getRecentConversations: vi.fn().mockResolvedValue([])
    });

    return {
        sessionManager: createSessionManager(),
        whatsappService: createWhatsAppService(),
        recentsService: createRecentsService(),
        menuHandler: { handleCommand: vi.fn() },
        incomingMediaService: {
            process: vi.fn().mockResolvedValue({ text: 'plain text' })
        },
        extractIncomingText: vi.fn().mockReturnValue({ kind: 'text', text: 'plain text' }),
        reset() {
            this.sessionManager = createSessionManager();
            this.whatsappService = createWhatsAppService();
            this.recentsService = createRecentsService();
            this.menuHandler = { handleCommand: vi.fn() };
            this.incomingMediaService = { process: vi.fn().mockResolvedValue({ text: 'plain text' }) };
            this.extractIncomingText = vi.fn().mockReturnValue({ kind: 'text', text: 'plain text' });
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
    return {
        handlers,
        tools,
        registerFlag: vi.fn(),
        on: vi.fn((name: string, handler: PiHandler) => handlers.set(name, handler)),
        registerCommand: vi.fn(),
        registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
        getFlag: vi.fn().mockReturnValue(false),
        appendEntry: vi.fn(),
        exec: vi.fn().mockResolvedValue({ code: 0 }),
        sendUserMessage: vi.fn()
    };
};

const createMockContext = () => ({
    ui: {
        setStatus: vi.fn(),
        notify: vi.fn()
    },
    sessionManager: {
        getEntries: vi.fn().mockReturnValue([])
    },
    compact: vi.fn(),
    abort: vi.fn()
});

const loadExtension = async () => {
    vi.resetModules();
    const module = await import('../../whatsapp-pi.ts');
    return module.default;
};

describe('whatsapp-pi — message callback & session events', () => {
    let pi: ReturnType<typeof createMockPi>;
    let messageCallback: ((m: any) => Promise<void>) | undefined;

    const boot = async () => {
        const registerExtension = await loadExtension();
        pi = createMockPi();
        registerExtension(pi as any);
        messageCallback = mocks.whatsappService.setMessageCallback.mock.calls[0][0];
    };

    const dm = (text: string, extra: Record<string, any> = {}) => ({
        messages: [{
            key: { remoteJid: '33684136128@s.whatsapp.net', id: 'M1', ...(extra.key ?? {}) },
            message: { conversation: text },
            pushName: 'Ben',
            ...(extra.top ?? {})
        }]
    });

    beforeEach(async () => {
        resetI18n();
        vi.stubEnv('WHATSAPP_PI_LOCALE', '');
        mocks.reset();
        vi.clearAllMocks();
        mocks.incomingMediaService.process.mockImplementation(async (resolved: any) => ({ text: resolved.text }));
        mocks.extractIncomingText.mockImplementation((message: any) => ({
            kind: 'text',
            text: message?.conversation ?? message?.extendedTextMessage?.text ?? ''
        }));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await boot();
    });

    const lastSentText = (): string => {
        const calls = pi.sendUserMessage.mock.calls;
        return calls[calls.length - 1][0];
    };

    it('formats an incoming DM with the standard header', async () => {
        await messageCallback!(dm('couleur du ciel ?'));

        const sent = lastSentText();
        expect(sent).toContain('Message from Ben (33684136128):');
        expect(sent).toContain('couleur du ciel ?');
        expect(mocks.whatsappService.markRead).toHaveBeenCalled();
        expect(mocks.whatsappService.sendPresence).toHaveBeenCalledWith(expect.anything(), 'composing');
    });

    it('formats fromMe messages as "sent to <looked-up name>"', async () => {
        mocks.sessionManager.getAllowList.mockReturnValue([
            { number: '+33684136128', name: 'Patrice' }
        ]);

        await messageCallback!(dm('photo envoyée', { key: { fromMe: true } }));

        const sent = lastSentText();
        expect(sent).toContain('Ben sent to Patrice:');
        expect(sent).not.toContain('Message from');
    });

    it('adds a media indicator for fromMe image messages', async () => {
        mocks.extractIncomingText.mockReturnValue({ kind: 'image', text: 'Photo' });
        mocks.incomingMediaService.process.mockResolvedValue({ text: 'Photo' });

        await messageCallback!(dm('Photo', { key: { fromMe: true } }));

        expect(lastSentText()).toContain('📷 Photo');
    });

    it('formats operator messages with the [Operator] prefix', async () => {
        mocks.whatsappService.getOperatorJid.mockReturnValue('33684136128@s.whatsapp.net');

        await messageCallback!(dm('ordre du jour'));

        expect(lastSentText()).toContain('[Operator] Ben (33684136128):');
    });

    it('formats group messages with participant and group JID', async () => {
        const payload = {
            messages: [{
                key: {
                    remoteJid: '120363409409770410@g.us',
                    participant: '56242697425006@lid',
                    id: 'M2'
                },
                message: { conversation: 'salut la team' },
                pushName: 'Sebastian'
            }]
        };

        await messageCallback!(payload);

        const sent = lastSentText();
        expect(sent).toContain('Message from Sebastian (56242697425006) in group 120363409409770410@g.us:');
    });

    it('sends image messages with an image content block', async () => {
        mocks.incomingMediaService.process.mockResolvedValue({
            text: 'voici la photo',
            imageBuffer: Buffer.from('imgbytes'),
            imageMimeType: 'image/jpeg'
        });

        await messageCallback!(dm('regarde'));

        const call = pi.sendUserMessage.mock.calls[pi.sendUserMessage.mock.calls.length - 1];
        const blocks = call[0];
        expect(blocks[0].text).toContain('Message from Ben');
        expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    });

    it('logs system messages without injecting them into the session', async () => {
        mocks.extractIncomingText.mockReturnValue({ kind: 'system', text: '[History sync]' });

        await messageCallback!(dm('ignored'));

        expect(pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it('handles /compact by compacting and confirming', async () => {
        const ctx = createMockContext();
        await pi.handlers.get('session_start')!({}, ctx);

        await messageCallback!(dm('/compact'));

        expect(ctx.compact).toHaveBeenCalled();
        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '33684136128@s.whatsapp.net', expect.stringContaining('compacted')
        );
        // The message is injected first, then the command short-circuits the flow.
    });

    it('handles /abort by aborting and confirming', async () => {
        const ctx = createMockContext();
        await pi.handlers.get('session_start')!({}, ctx);

        await messageCallback!(dm('/ABORT'));

        expect(ctx.abort).toHaveBeenCalled();
        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '33684136128@s.whatsapp.net', expect.stringContaining('Aborted')
        );
    });

    describe('session lifecycle', () => {
        it('wires the incoming recorder into the recents service', async () => {
            const ctx = createMockContext();
            await pi.handlers.get('session_start')!({}, ctx);

            const recorder = mocks.whatsappService.setIncomingMessageRecorder.mock.calls[0][0];
            await recorder({
                id: 'REC1',
                remoteJid: '33684136128@s.whatsapp.net',
                pushName: 'Ben',
                text: 'hello',
                timestamp: 123
            });

            expect(mocks.recentsService.recordMessage).toHaveBeenCalledWith({
                messageId: 'REC1',
                senderNumber: '+33684136128',
                senderName: 'Ben',
                text: 'hello',
                direction: 'incoming',
                timestamp: 123
            });
        });

        it('records group messages in the recorder with the group JID as sender', async () => {
            const ctx = createMockContext();
            await pi.handlers.get('session_start')!({}, ctx);

            const recorder = mocks.whatsappService.setIncomingMessageRecorder.mock.calls[0][0];
            await recorder({
                id: 'REC2',
                remoteJid: '120363409409770410@g.us',
                pushName: undefined,
                text: 'group msg',
                timestamp: 456
            });

            expect(mocks.recentsService.recordMessage).toHaveBeenCalledWith(
                expect.objectContaining({ senderNumber: '120363409409770410@g.us' })
            );
        });

        it('restores allow list and groups from the saved session state', async () => {
            const ctx = createMockContext();
            ctx.sessionManager.getEntries.mockReturnValue([
                {
                    type: 'custom',
                    customType: 'whatsapp-state',
                    data: {
                        status: 'connected',
                        allowList: ['+33684136128', { number: '+157831491797218', name: 'Patrice' }],
                        allowedGroups: [{ number: '120363409409770410@g.us', name: 'Family' }]
                    }
                }
            ]);

            await pi.handlers.get('session_start')!({}, ctx);

            expect(mocks.sessionManager.addNumber).toHaveBeenCalledWith('+33684136128', undefined);
            expect(mocks.sessionManager.addNumber).toHaveBeenCalledWith('+157831491797218', 'Patrice');
            expect(mocks.sessionManager.addAllowedGroup).toHaveBeenCalledWith(
                '120363409409770410@g.us', 'Family'
            );
        });

        it('downgrades a restored connected status when auto-connect is off', async () => {
            const ctx = createMockContext();
            ctx.sessionManager.getEntries.mockReturnValue([
                { type: 'custom', customType: 'whatsapp-state', data: { status: 'connected' } }
            ]);
            mocks.sessionManager.getAutoConnect.mockReturnValue(false);

            await pi.handlers.get('session_start')!({}, ctx);

            expect(mocks.sessionManager.setStatus).toHaveBeenCalledWith('disconnected');
        });

        it('session_shutdown stops the WhatsApp service', async () => {
            const ctx = createMockContext();

            await pi.handlers.get('session_shutdown')!({}, ctx);

            expect(mocks.whatsappService.stop).toHaveBeenCalled();
        });

        it('footer status shows the chat count when connected', async () => {
            mocks.sessionManager.getAllowList.mockReturnValue([{ number: '+111' }]);
            mocks.sessionManager.getAllowedGroups.mockReturnValue([{ number: 'g@g.us' }]);
            const ctx = createMockContext();

            await pi.handlers.get('session_start')!({}, ctx);

            // Drive the registered status callback with a connected status.
            const statusCb = mocks.whatsappService.setStatusCallback.mock.calls[0][0];
            (ctx.ui.setStatus as any).mockClear();
            statusCb(t('service.whatsapp.connected'));

            const last = (ctx.ui.setStatus as any).mock.calls.at(-1)[1];
            expect(last).toContain('2 chats');
        });

        it('footer status shows "No chats" when no lists are configured', async () => {
            const ctx = createMockContext();

            await pi.handlers.get('session_start')!({}, ctx);

            const statusCb = mocks.whatsappService.setStatusCallback.mock.calls[0][0];
            (ctx.ui.setStatus as any).mockClear();
            statusCb(t('service.whatsapp.connected'));

            expect((ctx.ui.setStatus as any).mock.calls.at(-1)[1]).toContain('No chats');
        });

        it('footer passes non-connected statuses through unchanged', async () => {
            const ctx = createMockContext();

            await pi.handlers.get('session_start')!({}, ctx);

            const statusCb = mocks.whatsappService.setStatusCallback.mock.calls[0][0];
            (ctx.ui.setStatus as any).mockClear();
            statusCb('| WhatsApp: Disconnected');

            expect((ctx.ui.setStatus as any).mock.calls.at(-1)[1]).toBe('| WhatsApp: Disconnected');
        });
    });
});