import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';
import { MessageSender } from '../../src/services/message.sender.ts';

// Keep fileLog() from appending to the real ~/.pi log during tests.
const fsMocks = vi.hoisted(() => ({
    appendFileSync: vi.fn(),
    readFileSync: vi.fn()
}));

vi.mock('fs', () => ({
    appendFileSync: fsMocks.appendFileSync,
    readFileSync: fsMocks.readFileSync,
    default: { appendFileSync: fsMocks.appendFileSync, readFileSync: fsMocks.readFileSync }
}));

describe('MessageSender', () => {
    const logger = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const whatsappService = {
        getStatus: vi.fn(),
        getSocket: vi.fn(),
        isVerbose: vi.fn(),
        getLogger: vi.fn().mockReturnValue(logger),
        getBrandVisibility: vi.fn().mockReturnValue(true),
        prepareGroupSession: vi.fn().mockResolvedValue(undefined)
    };

    beforeEach(() => {
        resetI18n();
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        whatsappService.getStatus.mockReturnValue('connected');
        whatsappService.isVerbose.mockReturnValue(false);
        whatsappService.getBrandVisibility.mockReturnValue(true);
        whatsappService.getLogger.mockReturnValue(logger);
        fsMocks.appendFileSync.mockImplementation(() => {});
    });

    it('sends branded text through the active socket', async () => {
        const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'MSG123' } });
        whatsappService.getSocket.mockReturnValue({ sendMessage });
        const sender = new MessageSender(whatsappService as any);

        await expect(sender.send({
            recipientJid: '5511999998888@s.whatsapp.net',
            text: 'hello'
        })).resolves.toEqual({
            success: true,
            messageId: 'MSG123',
            attempts: 1
        });

        expect(sendMessage).toHaveBeenCalledWith('5511999998888@s.whatsapp.net', {
            text: 'hello π'
        });
    });

    it('sends unbranded text when brand visibility is disabled', async () => {
        whatsappService.getBrandVisibility.mockReturnValue(false);
        const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'MSG456' } });
        whatsappService.getSocket.mockReturnValue({ sendMessage });
        const sender = new MessageSender(whatsappService as any);

        await sender.send({ recipientJid: '5511999998888@s.whatsapp.net', text: 'hello' });

        expect(sendMessage).toHaveBeenCalledWith('5511999998888@s.whatsapp.net', { text: 'hello' });
    });

    it('prepares the group session and forces metadata refresh for group recipients', async () => {
        const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'G1' } });
        whatsappService.getSocket.mockReturnValue({ sendMessage });
        const sender = new MessageSender(whatsappService as any);

        const result = await sender.send({
            recipientJid: '120363409409770410@g.us',
            text: 'group hello'
        });

        expect(whatsappService.prepareGroupSession).toHaveBeenCalledWith('120363409409770410@g.us', true);
        expect(result.success).toBe(true);
        expect(sendMessage).toHaveBeenCalledWith('120363409409770410@g.us', { text: 'group hello π' });
    });

    it('passes useCachedGroupMetadata through when provided', async () => {
        const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'C1' } });
        whatsappService.getSocket.mockReturnValue({ sendMessage });
        const sender = new MessageSender(whatsappService as any);

        await sender.send({
            recipientJid: '120363409409770410@g.us',
            text: 'cached',
            options: { useCachedGroupMetadata: true }
        });

        expect(sendMessage).toHaveBeenCalledWith('120363409409770410@g.us', {
            text: 'cached π',
            useCachedGroupMetadata: true
        });
    });

    it('returns failure when no socket is available and retries are exhausted', async () => {
        vi.useFakeTimers();
        whatsappService.getSocket.mockReturnValue(undefined);
        const sender = new MessageSender(whatsappService as any);

        const resultPromise = sender.send({
            recipientJid: '5511999998888@s.whatsapp.net',
            text: 'hello',
            options: { maxRetries: 2 }
        });

        await vi.advanceTimersByTimeAsync(2000);
        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'WhatsApp socket not initialized',
            attempts: 2
        });
        vi.useRealTimers();
    });

    it('logs retry delay through the logger when verbose is enabled', async () => {
        vi.useFakeTimers();
        whatsappService.getSocket.mockReturnValue(undefined);
        whatsappService.isVerbose.mockReturnValue(true);
        const sender = new MessageSender(whatsappService as any);

        const resultPromise = sender.send({
            recipientJid: '5511999998888@s.whatsapp.net',
            text: 'hello',
            options: { maxRetries: 2 }
        });

        await vi.advanceTimersByTimeAsync(2000);
        await resultPromise;

        expect(logger.info).toHaveBeenCalledWith('[MessageSender] Retrying in 2000ms...');
        vi.useRealTimers();
    });

    it('does not log retry delay when verbose is disabled', async () => {
        vi.useFakeTimers();
        whatsappService.getSocket.mockReturnValue(undefined);
        whatsappService.isVerbose.mockReturnValue(false);
        const sender = new MessageSender(whatsappService as any);

        const resultPromise = sender.send({
            recipientJid: '5511999998888@s.whatsapp.net',
            text: 'hello',
            options: { maxRetries: 2 }
        });

        await vi.advanceTimersByTimeAsync(2000);
        await resultPromise;

        expect(logger.info).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('sendMedia reads the file and sends the right content type', async () => {
        const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'M1' } });
        whatsappService.getSocket.mockReturnValue({ sendMessage });
        fsMocks.readFileSync.mockReturnValue(Buffer.from('image-bytes'));
        const sender = new MessageSender(whatsappService as any);

        const result = await sender.sendMedia('5511999998888@s.whatsapp.net', '/tmp/photo.jpg', 'image', 'caption');

        expect(result).toEqual({ success: true, messageId: 'M1', attempts: 1 });
        expect(sendMessage).toHaveBeenCalledWith('5511999998888@s.whatsapp.net', {
            image: Buffer.from('image-bytes'),
            caption: 'caption'
        });
    });

    it('sendMedia returns failure after exhausting retries', async () => {
        vi.useFakeTimers();
        whatsappService.getSocket.mockReturnValue(undefined);
        const sender = new MessageSender(whatsappService as any);

        const resultPromise = sender.sendMedia('5511999998888@s.whatsapp.net', '/tmp/photo.jpg', 'image');

        await vi.advanceTimersByTimeAsync(10_000);
        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Failed to send image after 2 attempts',
            attempts: 2
        });
        vi.useRealTimers();
    });

    it('addGroupParticipants normalizes JIDs and reports success', async () => {
        const groupParticipantsUpdate = vi.fn().mockResolvedValue(undefined);
        whatsappService.getSocket.mockReturnValue({ groupParticipantsUpdate });
        const sender = new MessageSender(whatsappService as any);

        await expect(sender.addGroupParticipants('120363409409770410@g.us', ['5511999998888'])).resolves.toEqual({ success: true });
        expect(groupParticipantsUpdate).toHaveBeenCalledWith('120363409409770410@g.us', ['5511999998888@s.whatsapp.net'], 'add');
    });

    it('addGroupParticipants reports failure when the socket rejects', async () => {
        const groupParticipantsUpdate = vi.fn().mockRejectedValue(new Error('not admin'));
        whatsappService.getSocket.mockReturnValue({ groupParticipantsUpdate });
        const sender = new MessageSender(whatsappService as any);

        await expect(sender.addGroupParticipants('120363409409770410@g.us', ['5511999998888@s.whatsapp.net'])).resolves.toEqual({
            success: false,
            error: 'not admin'
        });
    });

    it('removeGroupParticipants normalizes JIDs and reports success', async () => {
        const groupParticipantsUpdate = vi.fn().mockResolvedValue(undefined);
        whatsappService.getSocket.mockReturnValue({ groupParticipantsUpdate });
        const sender = new MessageSender(whatsappService as any);

        await expect(sender.removeGroupParticipants('120363409409770410@g.us', ['5511999998888@s.whatsapp.net'])).resolves.toEqual({ success: true });
        expect(groupParticipantsUpdate).toHaveBeenCalledWith('120363409409770410@g.us', ['5511999998888@s.whatsapp.net'], 'remove');
    });

    it('removeGroupParticipants reports failure when the socket rejects', async () => {
        const groupParticipantsUpdate = vi.fn().mockRejectedValue(new Error('boom'));
        whatsappService.getSocket.mockReturnValue({ groupParticipantsUpdate });
        const sender = new MessageSender(whatsappService as any);

        await expect(sender.removeGroupParticipants('120363409409770410@g.us', ['x'])).resolves.toEqual({
            success: false,
            error: 'boom'
        });
    });
});

describe('MessageSender — remaining branches', () => {
    const logger = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const whatsappService = {
        getStatus: vi.fn(),
        getSocket: vi.fn(),
        isVerbose: vi.fn().mockReturnValue(false),
        getLogger: vi.fn().mockReturnValue(logger),
        getBrandVisibility: vi.fn().mockReturnValue(true),
        prepareGroupSession: vi.fn().mockResolvedValue(undefined)
    };

    beforeEach(() => {
        resetI18n();
        vi.clearAllMocks();
        whatsappService.getStatus.mockReturnValue('connected');
        whatsappService.getBrandVisibility.mockReturnValue(true);
        whatsappService.getLogger.mockReturnValue(logger);
        fsMocks.appendFileSync.mockImplementation(() => {});
        fsMocks.readFileSync.mockReturnValue(Buffer.from('bin'));
    });

    it('waitIfOffline throws TIMEOUT when the service stays disconnected', async () => {
        vi.useFakeTimers();
        try {
            whatsappService.getStatus.mockReturnValue('disconnected');
            const sender = new MessageSender(whatsappService as any);

            const promise = sender.send({ recipientJid: '111@s.whatsapp.net', text: 'hi' } as any);
            for (let i = 0; i < 35; i++) {
                await vi.advanceTimersByTimeAsync(1_000);
            }
            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.error).toContain('Timed out');
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops retrying immediately on a TIMEOUT error', async () => {
        vi.useFakeTimers();
        try {
            // Offline forever -> TIMEOUT on the first wait -> no socket reached.
            whatsappService.getStatus.mockReturnValue('disconnected');
            const sender = new MessageSender(whatsappService as any);

            const promise = sender.send({ recipientJid: '111@s.whatsapp.net', text: 'hi' } as any);
            for (let i = 0; i < 35; i++) {
                await vi.advanceTimersByTimeAsync(1_000);
            }
            const result = await promise;

            // TIMEOUT is non-retryable: exactly one failed attempt.
            expect(result.success).toBe(false);
            expect(result.attempts).toBe(1);
            expect(whatsappService.getSocket).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('sendMedia fails cleanly without a socket', async () => {
        whatsappService.getSocket.mockReturnValue(null);
        const sender = new MessageSender(whatsappService as any);

        const result = await sender.sendMedia('111@s.whatsapp.net', '/tmp/x.jpg', 'image');

        expect(result.success).toBe(false);
    });

    it('sendMedia prepares the group session for group recipients', async () => {
        const socket = { sendMessage: vi.fn().mockResolvedValue({ key: { id: 'G1' } }) };
        whatsappService.getSocket.mockReturnValue(socket);
        fsMocks.readFileSync.mockReturnValue(Buffer.from('bin'));
        const sender = new MessageSender(whatsappService as any);

        const result = await sender.sendMedia('120363409409770410@g.us', '/tmp/x.jpg', 'image');

        expect(whatsappService.prepareGroupSession).toHaveBeenCalledWith(
            '120363409409770410@g.us', true
        );
        expect(result.success).toBe(true);
    });

    it('group participant helpers fail without a socket', async () => {
        whatsappService.getSocket.mockReturnValue(null);
        const sender = new MessageSender(whatsappService as any);

        const add = await sender.addGroupParticipants('123@g.us', ['+111']);
        const remove = await sender.removeGroupParticipants('123@g.us', ['+111']);

        expect(add.success).toBe(false);
        expect(remove.success).toBe(false);
    });
});
