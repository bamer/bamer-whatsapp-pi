import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';

// Intercept fileLog writes (appendFileSync) so nothing touches the real ~/.pi log.
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
            user: { id: '5511999998888:0@s.whatsapp.net', lid: '64175502004378:0@lid' },
            sendMessage: vi.fn().mockResolvedValue({ key: { id: 'WELCOME' } }),
            logout: vi.fn().mockResolvedValue(undefined),
            readMessages: vi.fn().mockResolvedValue(undefined),
            sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
            groupMetadata: vi.fn().mockResolvedValue({
                id: '120363409409770410@g.us',
                participants: [{ id: 'a@s.whatsapp.net' }, { jid: 'b@s.whatsapp.net' }]
            }),
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
        makeCacheableSignalKeyStore: vi.fn((_keys: any, _logger: any) => _keys),
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
    DisconnectReason: {
        loggedOut: 401,
        badSession: 500,
        connectionReplaced: 440,
        timedOut: 408,
        connectionLost: 409
    }
}));

const createSessionManager = () => ({
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
    isAllowedGroup: vi.fn().mockReturnValue(true)
});

describe('WhatsAppService — socket lifecycle', () => {
    const statusMessages: string[] = [];

    const boot = async () => {
        const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
        const sessionManager = createSessionManager();
        const service = new WhatsAppService(sessionManager as any);
        service.setStatusCallback((msg: string) => statusMessages.push(msg));
        await service.start();
        return { service, sessionManager, socket: baileysMocks.sockets[0] };
    };

    beforeEach(() => {
        resetI18n();
        baileysMocks.reset();
        statusMessages.length = 0;
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('creds.update persists credentials and marks auth state available', async () => {
        const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
        const sessionManager = createSessionManager();
        const service = new WhatsAppService(sessionManager as any);
        await service.start();
        const socket = baileysMocks.sockets[0];
        const saveCreds = (await sessionManager.getAuthState.mock.results[0].value).saveCreds;

        await socket.handlers.get('creds.update')!({});

        expect(saveCreds).toHaveBeenCalled();
        expect(sessionManager.markAuthStateAvailable).toHaveBeenCalled();

        await service.stop();
    });

    it('connection open without prior QR reaches connected without sending a welcome', async () => {
        const { service, sessionManager, socket } = await boot();

        await socket.handlers.get('connection.update')!({ connection: 'open' });

        expect(sessionManager.setStatus).toHaveBeenCalledWith('connected');
        expect(sessionManager.setOperatorJid).not.toHaveBeenCalled();
        expect(socket.sendMessage).not.toHaveBeenCalled();

        await service.stop();
    });

    it('schedules a reconnect after a retryable close and dials again', async () => {
        vi.useFakeTimers();
        const { service, socket } = await boot();

        // Retryable disconnect (timed out = 408, not loggedOut 401).
        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 408 } } }
        });

        expect(statusMessages.some((m) => m.toLowerCase().includes('reconnect'))).toBe(true);

        await vi.advanceTimersByTimeAsync(120_000); // beyond the capped backoff

        expect(baileysMocks.sockets.length).toBeGreaterThan(1); // a new socket was dialed

        await service.stop();
    });

    it('does not reconnect after an intentional stop', async () => {
        vi.useFakeTimers();
        const { service, socket } = await boot();

        await service.stop(); // intentionalStop = true

        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 408 } } }
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(baileysMocks.sockets.length).toBe(1); // no redial
    });

    it('treats a loggedOut close as final: disconnected status, no redial', async () => {
        vi.useFakeTimers();
        const { service, sessionManager } = await boot();
        const socket = baileysMocks.sockets[0];

        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 401 } } }
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(sessionManager.setStatus).toHaveBeenCalledWith('disconnected');
        expect(baileysMocks.sockets.length).toBe(1);

        await service.stop();
    });

    it('shows Session Preserved on an auth-rejected close (400) without redialing', async () => {
        vi.useFakeTimers();
        const { service, sessionManager } = await boot();
        const socket = baileysMocks.sockets[0];

        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 400 }, message: 'bad-request' } }
        });

        // Session Preserved: auth files are kept, no reconnect loop, user re-pairs via QR.
        expect(statusMessages.some((m) => m.includes('Session Preserved'))).toBe(true);
        expect(sessionManager.setStatus).toHaveBeenCalledWith('disconnected');
        expect(sessionManager.deleteAuthState).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(120_000);
        expect(baileysMocks.sockets.length).toBe(1); // no redial

        await service.stop();
    });

    it('reports a dedicated status on Bad MAC errors', async () => {
        const { service, sessionManager } = await boot();
        const socket = baileysMocks.sockets[0];

        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 500 }, message: 'Bad MAC' } }
        });

        expect(statusMessages.some((m) => m.toLowerCase().includes('bad mac'))).toBe(true);
        expect(sessionManager.setStatus).toHaveBeenCalledWith('disconnected');

        await service.stop();
    });

    it('handles connectionReplaced (440) without scheduling a redial', async () => {
        vi.useFakeTimers();
        const { service, sessionManager } = await boot();
        const socket = baileysMocks.sockets[0];

        await socket.handlers.get('connection.update')!({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 440 } } }
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(statusMessages.length).toBeGreaterThan(0); // conflict notice emitted
        expect(sessionManager.setStatus).toHaveBeenCalledWith('disconnected');
        expect(baileysMocks.sockets.length).toBe(1);

        await service.stop();
    });

    it('stop() saves creds, tears down the socket and flips to disconnected', async () => {
        const { service, sessionManager, socket } = await boot();

        await service.stop();

        expect(socket.end).toHaveBeenCalled();
        expect(socket.ev.removeAllListeners).toHaveBeenCalledWith('connection.update');
        expect(sessionManager.setStatus).toHaveBeenCalledWith('disconnected');
    });

    it('logout() attempts socket logout then always deletes auth state', async () => {
        const { service, sessionManager, socket } = await boot();

        await service.logout();

        expect(socket.logout).toHaveBeenCalled();
        expect(sessionManager.deleteAuthState).toHaveBeenCalled();
    });

    it('logout() survives a socket.logout() rejection', async () => {
        const { service, sessionManager, socket } = await boot();
        socket.logout.mockRejectedValue(new Error('socket closed'));

        await expect(service.logout()).resolves.toBeUndefined();
        expect(sessionManager.deleteAuthState).toHaveBeenCalled();
    });

    describe('sendMenuMessage', () => {
        it('fails fast with a not-connected error when there is no active socket', async () => {
            const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
            const sessionManager = createSessionManager();
            sessionManager.getStatus.mockReturnValue('disconnected');
            const service = new WhatsAppService(sessionManager as any);

            const result = await service.sendMenuMessage('+33123456789', 'hello');

            expect(result.success).toBe(false);
            expect(result.attempts).toBe(0);
        });

        it('sends through the raw socket with composing/paused presence bracketing', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');

            const result = await service.sendMenuMessage('+33123456789@s.whatsapp.net', 'menu text');

            expect(result.success).toBe(true);
            expect(result.messageId).toBe('WELCOME');
            expect(socket.sendMessage).toHaveBeenCalledWith(
                '+33123456789@s.whatsapp.net',
                expect.objectContaining({ text: 'menu text' })
            );
            expect(socket.sendPresenceUpdate).toHaveBeenCalledWith('composing', '+33123456789@s.whatsapp.net');
            expect(socket.sendPresenceUpdate).toHaveBeenCalledWith('paused', '+33123456789@s.whatsapp.net');

            await service.stop();
        });

        it('returns a formatted failure when the raw send throws', async () => {
            const { service, sessionManager, socket } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');
            socket.sendMessage.mockRejectedValue(new Error('stale session'));

            const result = await service.sendMenuMessage('+33123456789@s.whatsapp.net', 'oops');

            expect(result.success).toBe(false);
            expect(result.error).toBe('stale session');
            expect(result.attempts).toBe(1);

            await service.stop();
        });

        it('resolves the recipient through the allowed-contact send number', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');
            sessionManager.getAllowedContact.mockImplementation((num: string) =>
                num === '1234567890' || num === '+1234567890'
                    ? { number: '+1234567890', sendNumber: '+5511888887777' }
                    : undefined
            );

            await service.sendMenuMessage('+1234567890@s.whatsapp.net', 'reroute me');

            expect(socket.sendMessage).toHaveBeenCalledWith(
                '5511888887777@s.whatsapp.net',
                expect.objectContaining({ text: 'reroute me' })
            );

            await service.stop();
        });
    });

    describe('presence & read receipts', () => {
        it('sendPresence and markRead are silent no-ops without an active socket', async () => {
            const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
            const sessionManager = createSessionManager();
            sessionManager.getStatus.mockReturnValue('disconnected');
            const service = new WhatsAppService(sessionManager as any);

            await expect(service.sendPresence('+111', 'composing')).resolves.toBeUndefined();
            await expect(service.markRead('+111', 'MSG1')).resolves.toBeUndefined();
        });

        it('markRead forwards to readMessages and swallows errors', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');

            await service.markRead('+111@s.whatsapp.net', 'MSG-9', true);
            expect(socket.readMessages).toHaveBeenCalledWith([
                { remoteJid: '+111@s.whatsapp.net', id: 'MSG-9', fromMe: true }
            ]);

            socket.readMessages.mockRejectedValue(new Error('read failed'));
            await expect(service.markRead('+111@s.whatsapp.net', 'MSG-10')).resolves.toBeUndefined();

            await service.stop();
        });
    });

    describe('prepareGroupSession caching', () => {
        const GROUP = '120363409409770410@g.us';

        it('ignores non-group JIDs entirely', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');

            await service.prepareGroupSession('+111@s.whatsapp.net');

            expect(socket.groupMetadata).not.toHaveBeenCalled();
            await service.stop();
        });

        it('fetches and caches metadata, then serves later calls from the cache', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');

            await service.prepareGroupSession(GROUP);
            expect(socket.groupMetadata).toHaveBeenCalledTimes(1);

            await service.prepareGroupSession(GROUP); // cache HIT
            expect(socket.groupMetadata).toHaveBeenCalledTimes(1);

            await service.prepareGroupSession(GROUP, true); // forced refresh
            expect(socket.groupMetadata).toHaveBeenCalledTimes(2);

            await service.stop();
        });

        it('tolerates metadata fetch failures', async () => {
            const { service, socket, sessionManager } = await boot();
            sessionManager.getStatus.mockReturnValue('connected');
            socket.groupMetadata.mockRejectedValue(new Error('not in group'));

            await expect(service.prepareGroupSession(GROUP)).resolves.toBeUndefined();

            await service.stop();
        });

        it('skips fetching when there is no active socket', async () => {
            const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
            const sessionManager = createSessionManager();
            sessionManager.getStatus.mockReturnValue('disconnected');
            const service = new WhatsAppService(sessionManager as any);

            await service.prepareGroupSession(GROUP);

            expect(baileysMocks.sockets.length).toBe(0); // never dialed
        });
    });

    it('media and participant helpers delegate to the message sender', async () => {
        const { service } = await boot();

        const mediaSpy = vi.spyOn((service as any).messageSender, 'sendMedia')
            .mockResolvedValue({ success: true, messageId: 'MEDIA-X', attempts: 1 });
        const addSpy = vi.spyOn((service as any).messageSender, 'addGroupParticipants')
            .mockResolvedValue({ success: true });
        const removeSpy = vi.spyOn((service as any).messageSender, 'removeGroupParticipants')
            .mockResolvedValue({ success: true });

        await expect(service.sendMediaMessage('+111', '/tmp/p.jpg', 'image', 'cap')).resolves.toEqual({
            success: true, messageId: 'MEDIA-X', attempts: 1
        });
        await expect(service.addGroupParticipants('g@g.us', ['+111'])).resolves.toEqual({ success: true });
        await expect(service.removeGroupParticipants('g@g.us', ['+111'])).resolves.toEqual({ success: true });

        expect(mediaSpy).toHaveBeenCalledWith('+111', '/tmp/p.jpg', 'image', 'cap');

        await service.stop();
    });

    describe('service surface & verbose branches', () => {
        it('exposes getters and toggling verbose mode', async () => {
            const { service, sessionManager } = await boot();

            // No logger passed to the constructor here.
            expect(service.getLogger()).toBeUndefined();
            expect(service.getContactsService()).toBeDefined();
            expect(service.isVerbose()).toBe(false);
            expect(service.getBoundGroupJid()).toBeNull();
            expect(service.getBrandVisibility()).toBe(true);

            service.setGroupBinding('120363409409770410@g.us');
            expect(service.getBoundGroupJid()).toBe('120363409409770410@g.us');

            service.setVerboseMode(true);
            expect(service.isVerbose()).toBe(true);
            // Toggling again must not throw (restore filter is undefined).
            service.setVerboseMode(false);

            void sessionManager;
            await service.stop();
        });

        it('createSocket wires cachedGroupMetadata into the socket config', async () => {
            const { service } = await boot();

            const config = baileysMocks.makeWASocket.mock.calls[0][0];
            const metadata = { id: 'g@g.us', participants: [{ id: 'p@s.whatsapp.net' }] };
            (service as any).groupMetadataCache.set('g@g.us', { data: metadata, timestamp: Date.now() });

            await expect(config.cachedGroupMetadata('g@g.us')).resolves.toEqual(metadata);
            await expect(config.cachedGroupMetadata('unknown@g.us')).resolves.toBeUndefined();

            await service.stop();
        });

        it('sendMessage delegates with useCachedGroupMetadata=false', async () => {
            const { service } = await boot();
            const sendSpy = vi.spyOn((service as any).messageSender, 'send')
                .mockResolvedValue({ success: true, messageId: 'X1', attempts: 1 });

            const result = await service.sendMessage('+111@s.whatsapp.net', 'hello');

            expect(result.success).toBe(true);
            expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
                recipientJid: '+111@s.whatsapp.net',
                text: 'hello',
                options: { useCachedGroupMetadata: false }
            }));

            await service.stop();
        });

        it('logs presence/read failures in verbose mode without throwing', async () => {
            const { service, socket } = await boot();
            service.setVerboseMode(true);
            socket.sendPresenceUpdate.mockRejectedValue(new Error('presence boom'));
            socket.readMessages.mockRejectedValue(new Error('read boom'));

            await expect(service.sendPresence('+111', 'composing')).resolves.toBeUndefined();
            await expect(service.markRead('+111', 'M1')).resolves.toBeUndefined();

            await service.stop();
        });

        it('stop() tolerates saveCreds failures', async () => {
            const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
            const sessionManager = createSessionManager();
            const failingSaveCreds = Promise.resolve().then(() => {
                throw new Error('disk full');
            });
            sessionManager.getAuthState.mockResolvedValue({
                state: { creds: {}, keys: {} },
                saveCreds: vi.fn().mockReturnValue(failingSaveCreds)
            });
            const service = new WhatsAppService(sessionManager as any);
            await service.start();
            service.setVerboseMode(true);

            await expect(service.stop()).resolves.toBeUndefined();
        });

        it('sendQrWelcome skips silently when the socket has no user id', async () => {
            const { WhatsAppService } = await import('../../src/services/whatsapp.service.ts');
            const sessionManager = createSessionManager();
            const service = new WhatsAppService(sessionManager as any);
            await service.start();
            const socket = baileysMocks.sockets[0];
            (socket as any).user = undefined;

            await socket.handlers.get('connection.update')!({ qr: 'qr-string' });
            await socket.handlers.get('connection.update')!({ connection: 'open' });

            expect(sessionManager.setOperatorJid).not.toHaveBeenCalled();

            await service.stop();
        });
    });
});
