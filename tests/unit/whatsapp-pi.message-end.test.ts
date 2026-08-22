import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';

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
        getOperatorJid: vi.fn().mockReturnValue(''),
        getSocket: vi.fn().mockReturnValue(null),
        getContactsService: vi.fn().mockReturnValue({ fetchContactsFromGroups: vi.fn(), reclassifyContacts: vi.fn() }),
        sendMediaMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'MEDIA1' }),
        addGroupParticipants: vi.fn().mockResolvedValue({ success: true }),
        removeGroupParticipants: vi.fn().mockResolvedValue({ success: true }),
        getStatus: vi.fn().mockReturnValue('connected'),
        isVerbose: vi.fn().mockReturnValue(false),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'MSG123', attempts: 1 }),
        resolveOutboundRecipientJid: vi.fn((recipient: string) => recipient),
        getLastRemoteJid: vi.fn().mockReturnValue('5511999998888@s.whatsapp.net'),
        markRead: vi.fn(),
        sendPresence: vi.fn().mockResolvedValue(undefined)
    });

    const createRecentsService = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        recordMessage: vi.fn().mockResolvedValue(undefined)
    });

    const createMenuHandler = () => ({
        handleCommand: vi.fn().mockResolvedValue(undefined)
    });

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

interface MockPi {
    flags: Map<string, unknown>;
    handlers: Map<string, PiHandler>;
    commands: Map<string, any>;
    tools: Map<string, any>;
    registerFlag: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
    getFlag: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
}

const createMockPi = (): MockPi => {
    const flags = new Map<string, unknown>();
    const handlers = new Map<string, PiHandler>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();

    return {
        flags,
        handlers,
        commands,
        tools,
        registerFlag: vi.fn((name: string, config: unknown) => flags.set(name, config)),
        on: vi.fn((name: string, handler: PiHandler) => handlers.set(name, handler)),
        registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
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

const makeAssistantEvent = (text: string) => ({
    message: {
        role: 'assistant',
        content: [{ type: 'text', text }]
    }
});

// Flushes the fire-and-forget promise chains used by the message_end handler.
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('whatsapp-pi message_end handler', () => {
    beforeEach(() => {
        resetI18n();
        vi.stubEnv('WHATSAPP_PI_LOCALE', '');
        mocks.reset();
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('sends reply and records in recents on successful assistant message', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello back!'), ctx);
        await flushAsync();

        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '5511999998888@s.whatsapp.net',
            'Hello back!'
        );
        // Recents are recorded BEFORE the fire-and-forget send, with a pending id.
        expect(mocks.recentsService.recordMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                senderNumber: '+5511999998888',
                text: 'Hello back!',
                direction: 'outgoing'
            })
        );
        expect(ctx.ui.notify).toHaveBeenCalledWith('[message_end] SENT to 5511999998888@s.whatsapp.net', 'info');
    });

    it('skips when session is not connected', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.sessionManager.getStatus.mockReturnValue('disconnected');

        registerExtension(pi as any);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
    });

    it('skips when message role is not assistant', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('message_end')!({
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        }, ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
    });

    it('notifies error when sendMessage returns failure', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.whatsappService.sendMessage.mockResolvedValue({ success: false, error: 'timeout', attempts: 3 });

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);
        await flushAsync();

        // Fire-and-forget: recents are recorded even if the send fails.
        expect(mocks.recentsService.recordMessage).toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith('[message_end] FAILED to 5511999998888@s.whatsapp.net: timeout', 'error');
    });

    it('notifies error when sendMessage throws', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.whatsappService.sendMessage.mockRejectedValue(new Error('network error'));

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);
        await flushAsync();

        expect(ctx.ui.notify).toHaveBeenCalledWith('[message_end] ERROR sending to 5511999998888@s.whatsapp.net: Error: network error', 'error');
    });

    it('skips reply when send_wa_message tool already sent to the same JID', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);

        await pi.tools.get('send_wa_message').execute(
            'tool-call-id',
            { jid: '5511999998888@s.whatsapp.net', message: 'Tool message' }
        );
        vi.clearAllMocks();

        await pi.handlers.get('message_end')!(makeAssistantEvent('Agent text'), ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
        expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('sends again after the dedup flag is cleared by a prior message_end', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);

        await pi.tools.get('send_wa_message').execute(
            'tool-call-id',
            { jid: '5511999998888@s.whatsapp.net', message: 'Tool message' }
        );
        await pi.handlers.get('message_end')!(makeAssistantEvent('Skipped'), ctx);
        vi.clearAllMocks();

        await pi.handlers.get('message_end')!(makeAssistantEvent('Follow up'), ctx);
        await flushAsync();

        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '5511999998888@s.whatsapp.net',
            'Follow up'
        );
    });
});
