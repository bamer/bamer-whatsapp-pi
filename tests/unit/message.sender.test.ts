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
