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
