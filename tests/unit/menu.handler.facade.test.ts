import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../src/i18n.ts';
import { MenuHandler } from '../../src/ui/menu.handler.ts';

vi.mock('qrcode-terminal', () => ({ generate: vi.fn() }));

vi.mock('../../src/ui/message-detail.view.ts', () => ({ showMessageDetailView: vi.fn() }));
vi.mock('../../src/ui/message-reply.view.ts', () => ({ showMessageReplyView: vi.fn() }));

// Root-menu dispatch tests only; domain modules are covered separately.
vi.mock('../../src/ui/menu/recents.menu.js', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    manageRecents: vi.fn().mockResolvedValue(undefined),
}));

const makeEnv = () => {
    const whatsappService = {
        getEffectiveStatus: vi.fn().mockReturnValue('connected'),
        setQRCodeCallback: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        sendMenuMessage: vi.fn().mockResolvedValue({ success: true }),
        getSocket: vi.fn().mockReturnValue(undefined),
        getContactsService: vi.fn()
    };
    const sessionManager = {
        isRegistered: vi.fn().mockResolvedValue(true),
        getStatus: vi.fn().mockReturnValue('connected')
    };
    const recentsService = {};
    return { whatsappService, sessionManager, recentsService };
};

const makeCtx = (selects: any[]) => {
    const queue = [...selects];
    return {
        ui: {
            select: vi.fn(async (_t: string, options: string[]) => {
                const c = queue.shift();
                if (typeof c === 'function') return c(_t, options);
                return c ?? options[options.length - 1];
            }),
            confirm: vi.fn(async () => true),
            input: vi.fn(async () => ''),
            notify: vi.fn()
        }
    };
};

describe('MenuHandler facade — root dispatch branches', () => {
    beforeEach(() => {
        resetI18n();
        vi.clearAllMocks();
    });

    it('connect: shows alreadyConnected when status is connected', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([t('menu.root.connectWhatsApp')]);

        await handler.handleCommand(ctx as any);

        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.root.alreadyConnected'), 'info');
        expect(whatsappService.start).not.toHaveBeenCalled();
    });

    it('connect: registers the QR callback and starts the service when disconnected', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        sessionManager.isRegistered.mockResolvedValue(false);
        whatsappService.getEffectiveStatus.mockReturnValue('disconnected');
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([t('menu.root.connectWhatsApp')]);

        await handler.handleCommand(ctx as any);

        expect(whatsappService.setQRCodeCallback).toHaveBeenCalled();
        expect(whatsappService.start).toHaveBeenCalled();
        // Not registered -> pairing message.
        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.root.pairingStarted'), 'info');
    });

    it('disconnect without connection reports alreadyDisconnected', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        whatsappService.getEffectiveStatus.mockReturnValue('disconnected');
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([t('menu.root.disconnectWhatsApp')]);

        await handler.handleCommand(ctx as any);

        expect(whatsappService.stop).not.toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.root.alreadyDisconnected'), 'info');
    });

    it('disconnect stops the service and warns', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([t('menu.root.disconnectWhatsApp')]);

        await handler.handleCommand(ctx as any);

        expect(whatsappService.stop).toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.root.agentDisconnected'), 'warning');
    });

    it('logoff asks for confirmation then logs out and deletes the session', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([
            t('menu.root.logoffDeleteSession'),
            t('menu.root.settings'),
            t('menu.settings.back'),
        ]);

        await handler.handleCommand(ctx as any);

        expect(ctx.ui.confirm).toHaveBeenCalled();
        expect(whatsappService.logout).toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.root.loggedOffAndDeleted'), 'info');
    });

    it('logoff keeps the session when confirmation is declined', async () => {
        const { whatsappService, sessionManager, recentsService } = makeEnv();
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        const ctx = makeCtx([
            t('menu.root.logoffDeleteSession'),
            t('menu.root.settings'),
            t('menu.settings.back'),
        ]);
        ctx.ui.confirm = vi.fn().mockResolvedValue(false);

        await handler.handleCommand(ctx as any);

        expect(whatsappService.logout).not.toHaveBeenCalled();
    });
});

describe('MenuHandler facade — domain dispatch', () => {
    beforeEach(() => {
        resetI18n();
        vi.clearAllMocks();
    });

    const boot = async (status = 'connected') => {
        const whatsappService = {
            getEffectiveStatus: vi.fn().mockReturnValue(status),
            setQRCodeCallback: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            logout: vi.fn(),
            sendMenuMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'M' }),
            getSocket: vi.fn().mockReturnValue(undefined),
            getContactsService: vi.fn().mockReturnValue({
                getCount: vi.fn().mockReturnValue(0),
                getCountBySource: vi.fn().mockReturnValue(0)
            })
        };
        const sessionManager = {
            isRegistered: vi.fn().mockResolvedValue(true),
            getAllowList: vi.fn().mockReturnValue([]),
            getAllowedGroups: vi.fn().mockReturnValue([]),
            getUpdateList: vi.fn().mockReturnValue([]),
            addNumber: vi.fn(),
            removeNumber: vi.fn(),
            addAllowedGroup: vi.fn(),
            removeAllowedGroup: vi.fn(),
            addUpdateNumber: vi.fn(),
            removeUpdateNumber: vi.fn(),
            setAllowedContactAlias: vi.fn(),
            removeAllowedContactAlias: vi.fn(),
            setAllowedGroupAlias: vi.fn(),
            removeAllowedGroupAlias: vi.fn(),
            setContactSendNumber: vi.fn(),
            removeContactSendNumber: vi.fn(),
            isConversationAllowed: vi.fn().mockReturnValue(false),
            isAllowedUpdateTarget: vi.fn().mockResolvedValue(false),
            getAllowedContact: vi.fn().mockReturnValue(undefined),
            getAllowedGroup: vi.fn().mockReturnValue(undefined),
            getBrandVisibility: vi.fn().mockReturnValue(true),
            setBrandVisibility: vi.fn(),
            getAutoConnect: vi.fn().mockReturnValue(false),
            setAutoConnect: vi.fn(),
            getAssistantName: vi.fn().mockReturnValue('Agent Pi'),
            setAssistantName: vi.fn(),
            getAgentSignature: vi.fn().mockReturnValue(''),
            setAgentSignature: vi.fn(),
            getLogMaxSizeMB: vi.fn().mockReturnValue(5),
            setLogMaxSizeMB: vi.fn(),
            getLogRetentionDays: vi.fn().mockReturnValue(7),
            setLogRetentionDays: vi.fn()
        };
        const recentsService = {
            getRecentConversations: vi.fn().mockResolvedValue([]),
            getConversationHistory: vi.fn().mockResolvedValue([]),
            recordMessage: vi.fn()
        };
        const handler = new MenuHandler(whatsappService as any, sessionManager as any, recentsService as any);
        return { handler, whatsappService, sessionManager, recentsService };
    };

    const makeCtx = () => ({
        ui: {
            select: vi.fn(async (_t: string, options: string[]) => options[0]),
            confirm: vi.fn(async () => false),
            input: vi.fn(async () => undefined),
            notify: vi.fn()
        }
    });

    it.each([
        ['recentsLabel'],
        ['contactsList'],
        ['allowedNumbers'],
        ['allowedGroups'],
        ['updateTargets'],
        ['settings'],
    ])('dispatches the %s entry to its module without crashing', async (key) => {
        const labels: Record<string, string> = {
            recentsLabel: t('menu.root.recents'),
            contactsList: t('menu.root.contactsList'),
            allowedNumbers: t('menu.root.allowedNumbers'),
            allowedGroups: t('menu.root.allowedGroups'),
            updateTargets: t('menu.root.updateTargets'),
            settings: t('menu.root.settings')
        };
        const { handler } = await boot();
        const ctx = makeCtx();
        // Every module terminates on Back/last option -> openRootMenu -> Back loop.
        // We stop after one round by making the second root select return undefined-ish.
        let calls = 0;
        ctx.ui.select.mockImplementation(async (_t: string, options: string[]) => {
            calls++;
            if (calls > 3) throw new Error('loop guard');
            // 1: root picks the entry; 2: module Back; 3: root Back.
            return calls === 1 ? labels[key] : options[options.length - 1];
        });

        await expect(handler.handleCommand(ctx as any)).resolves.toBeUndefined();
    });
});
