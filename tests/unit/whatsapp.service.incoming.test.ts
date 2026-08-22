import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';

const fsMocks = vi.hoisted(() => ({
    appendFileSync: vi.fn()
}));

vi.mock('fs', () => ({
    appendFileSync: fsMocks.appendFileSync,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ size: 0, mtimeMs: 0 }),
    unlinkSync: vi.fn(),
    default: { appendFileSync: fsMocks.appendFileSync }
}));

const baileysMocks = vi.hoisted(() => {
    const sockets: any[] = [];

    const createSocket = () => {
        const handlers = new Map<string, (event: any) => Promise<void>>();
        const socket = {
            handlers,
            user: { id: '5511999998888:49@s.whatsapp.net', lid: '64175502004378:49@lid' },
            sendMessage: vi.fn().mockResolvedValue({ key: { id: 'SENT' } }),
            logout: vi.fn(),
            readMessages: vi.fn().mockResolvedValue(undefined),
            sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
            groupMetadata: vi.fn().mockResolvedValue({ id: 'g@g.us', participants: [{ id: 'a@s.whatsapp.net' }] }),
            end: vi.fn(),
            ev: {
                on: vi.fn((event: string, handler: (event: any) => Promise<void>) => {
                    handlers.set(event, handler);
                }),
                removeAllListeners: vi.fn()
            }
        };
        sockets.push(socket);
        return socket;
    };

    return {
        sockets,
        makeWASocket: vi.fn(() => createSocket()),
        fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
        makeCacheableSignalKeyStore: vi.fn((_k: any, _l: any) => _k),
        reset() {
            sockets.length = 0;
            this.makeWASocket.mockReset().mockImplementation(() => createSocket());
            this.fetchLatestBaileysVersion.mockReset().mockResolvedValue({ version: [2, 3000, 0] });
            this.makeCacheableSignalKeyStore.mockReset().mockImplementation((_k: any, _l: any) => _k);
        }
    };
});

vi.mock('baileys', () => ({
    makeWASocket: baileysMocks.makeWASocket,
    fetchLatestBaileysVersion: baileysMocks.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: baileysMocks.makeCacheableSignalKeyStore,
    downloadContentFromMessage: vi.fn(),
    extractMessageContent: vi.fn((c: any) => c),
    DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440 }
}));

const createSessionManager = (overrides: Record<string, any> = {}) => ({
    getAuthState: vi.fn().mockResolvedValue({
        state: { creds: {}, keys: {} },
        saveCreds: vi.fn().mockResolvedValue(undefined)
    }),
    markAuthStateAvailable: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('connected'),
    setStatus: vi.fn().mockResolvedValue(undefined),
    deleteAuthState: vi.fn().mockResolvedValue(undefined),
    isAllowed: vi.fn().mockReturnValue(true),
    isConversationAllowed: vi.fn().mockReturnValue(true),
    isAllowedUpdateTarget: vi.fn().mockResolvedValue(false),
    getAgentSignature: vi.fn().mockReturnValue('π'),
    getBrandVisibility: vi.fn().mockReturnValue(true),
    getOperatorJid: vi.fn().mockReturnValue(''),
    setOperatorJid: vi.fn().mockResolvedValue(undefined),
    getAllowedContact: vi.fn().mockReturnValue(undefined),
    trackIgnoredNumber: vi.fn().mockResolvedValue(undefined),
    isAllowedGroup: vi.fn().mockReturnValue(true),
    ...overrides
});

describe('WhatsAppService — incoming message flows', () => {
    let recordedIncoming: any[];

    const boot = async (sessionManager?: any) => {
        const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
        const manager = sessionManager ?? createSessionManager();
        recordedIncoming = [];
        const service = new WhatsAppService(manager);
        service.setIncomingMessageRecorder((msg) => { recordedIncoming.push(msg); });
        service.setMessageCallback(vi.fn());
        await service.start();
        return { service, manager, socket: baileysMocks.sockets[0] };
    };

    const msg = (remoteJid: string, text: string, extra: Record<string, any> = {}) => ({
        messages: [{
            key: { remoteJid, id: 'MSG-1', ...(extra.key ?? {}) },
            message: { conversation: text },
            messageTimestamp: extra.timestamp ?? 1_800_000_000,
            pushName: extra.pushName
        }]
    });

    beforeEach(() => {
        resetI18n();
        baileysMocks.reset();
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
        // Ensure no stray reconnect timers survive between tests.
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('routes an allowed DM to the message callback and the recorder', async () => {
        const { service, manager, socket } = await boot();

        await socket.handlers.get('messages.upsert')!(msg('+33123456789@s.whatsapp.net', 'hello'));

        expect(service.getLastRemoteJid()).toBe('+33123456789@s.whatsapp.net');
        expect(manager.trackIgnoredNumber).not.toHaveBeenCalled();
        expect(recordedIncoming).toHaveLength(1);
        expect(recordedIncoming[0]).toEqual({
            id: 'MSG-1',
            remoteJid: '+33123456789@s.whatsapp.net',
            pushName: undefined,
            text: 'hello',
            timestamp: 1_800_000_000
        });

        await service.stop();
    });

    it('records pushName and tolerates string timestamps', async () => {
        const { service, socket } = await boot();

        await socket.handlers.get('messages.upsert')!(
            msg('+33123456789@s.whatsapp.net', 'yo', { timestamp: '1800000001', pushName: 'Ana' })
        );

        expect(recordedIncoming[0].pushName).toBe('Ana');
        expect(recordedIncoming[0].timestamp).toBe(1_800_000_001);

        await service.stop();
    });

    it('falls back to Date.now() for missing or junk timestamps', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(77_777);
        const { service, socket } = await boot();

        const payload = { messages: [{ key: { remoteJid: '+111@s.whatsapp.net', id: 'M' }, message: { conversation: 'x' } }] };
        await socket.handlers.get('messages.upsert')!(payload);

        expect(recordedIncoming[0].timestamp).toBe(77_777);

        await service.stop();
    });

    it('ignores messages when status is not connected', async () => {
        const { service, socket, manager } = await boot();
        manager.getStatus.mockReturnValue('disconnected');

        await socket.handlers.get('messages.upsert')!(msg('+111@s.whatsapp.net', 'hi'));

        expect(service.getLastRemoteJid()).toBeNull();
        expect(recordedIncoming).toHaveLength(0);

        await service.stop();
    });

    it('ignores payloads without a message or remoteJid', async () => {
        const { service, socket } = await boot();

        await socket.handlers.get('messages.upsert')!({ messages: [] });
        await socket.handlers.get('messages.upsert')!({ messages: [{ key: {} }] });

        expect(service.getLastRemoteJid()).toBeNull();

        await service.stop();
    });

    it('drops Pi-generated messages (signature suffix)', async () => {
        const { service, socket } = await boot();

        await socket.handlers.get('messages.upsert')!(msg('+111@s.whatsapp.net', 'my own echo π'));

        expect(recordedIncoming).toHaveLength(0);
        expect(service.getLastRemoteJid()).toBeNull();

        await service.stop();
    });

    it('accepts fromMe messages when the JID is in the allow list (linked devices)', async () => {
        const { service, socket, manager } = await boot();

        const payload = msg('+33123456789@s.whatsapp.net', 'typed from phone', { key: { fromMe: true } });
        await socket.handlers.get('messages.upsert')!(payload);

        expect(manager.isAllowedUpdateTarget).toHaveBeenCalled();
        expect(recordedIncoming).toHaveLength(1);
        expect(service.getLastRemoteJid()).toBe('+33123456789@s.whatsapp.net');

        await service.stop();
    });

    it('accepts fromMe when the JID is an update target even if not allowed', async () => {
        const manager = createSessionManager({
            isConversationAllowed: vi.fn().mockReturnValue(false),
            isAllowedUpdateTarget: vi.fn().mockResolvedValue(true)
        });
        const { service, socket } = await boot(manager);

        await socket.handlers.get('messages.upsert')!(
            msg('+9999@s.whatsapp.net', 'self note', { key: { fromMe: true } })
        );

        expect(recordedIncoming).toHaveLength(1);

        await service.stop();
    });

    it('drops fromMe messages targeting unknown contacts', async () => {
        const manager = createSessionManager({
            isConversationAllowed: vi.fn().mockReturnValue(false),
            isAllowedUpdateTarget: vi.fn().mockResolvedValue(false)
        });
        const { service, socket } = await boot(manager);

        await socket.handlers.get('messages.upsert')!(
            msg('+8888@s.whatsapp.net', 'sent to someone else', { key: { fromMe: true } })
        );

        expect(recordedIncoming).toHaveLength(0);
        expect(service.getLastRemoteJid()).toBeNull();

        await service.stop();
    });

    describe('group handling', () => {
        const GROUP = '120363409409770410@g.us';

        it('routes an allowed group message and eagerly caches metadata', async () => {
            const { service, manager, socket } = await boot();

            await socket.handlers.get('messages.upsert')!(msg(GROUP, 'group chat'));
            // prepareGroupSession is fire-and-forget; give it a tick.
            await new Promise((r) => setTimeout(r, 0));

            expect(service.getLastRemoteJid()).toBe(GROUP);
            expect(socket.groupMetadata).toHaveBeenCalledWith(GROUP);
            expect(manager.trackIgnoredNumber).not.toHaveBeenCalled();

            await service.stop();
        });

        it('tracks and drops messages from a disallowed bound group', async () => {
            const manager = createSessionManager({ isAllowedGroup: vi.fn().mockReturnValue(false) });
            const { service, socket, manager: m } = await boot(manager);
            service.setGroupBinding(GROUP);

            await socket.handlers.get('messages.upsert')!(msg(GROUP, 'who are you?'));

            expect(m.trackIgnoredNumber).toHaveBeenCalledWith(GROUP, undefined);
            expect(recordedIncoming).toHaveLength(1); // recorder still sees the raw message
            expect(service.getLastRemoteJid()).toBeNull(); // but onMessage never fires

            await service.stop();
        });

        it('drops messages from other groups while a group binding is active', async () => {
            const { service, socket } = await boot();
            service.setGroupBinding(GROUP);

            await socket.handlers.get('messages.upsert')!(msg('999@g.us', 'wrong room'));

            expect(service.getLastRemoteJid()).toBeNull();

            await service.stop();
        });

        it('tracks non-allowed senders in direct mode', async () => {
            const manager = createSessionManager({
                isConversationAllowed: vi.fn().mockReturnValue(false)
            });
            const { service, socket } = await boot(manager);

            await socket.handlers.get('messages.upsert')!(
                msg('+666@s.whatsapp.net', 'spam?', { pushName: 'Spammy' })
            );

            expect(service.getLastRemoteJid()).toBeNull();

            await service.stop();
        });
    });
});
