import { appendFileSync } from 'fs';
import { readFileSync } from 'fs';
import { t } from '../i18n.js';
import { MessageRequest, MessageResult, WhatsAppError } from '../models/whatsapp.types.js';
import { createStoragePaths } from './storage-path.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { WhatsAppService } from './whatsapp.service.js';

const LOG_FILE = createStoragePaths().logPath;
function fileLog(msg: string) {
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [MessageSender] ${msg}\n`); } catch {
        // File logging is best-effort.
    }
}

export class MessageSender {
    private whatsappService: WhatsAppService;
    private logger?: WhatsAppPiLogger;

    constructor(whatsappService: WhatsAppService) {
        this.whatsappService = whatsappService;
        this.logger = whatsappService.getLogger();
    }

    /**
     * Pauses execution for the specified time.
     * @param ms Milliseconds to sleep.
     */
    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Waits for the WhatsApp connection to be active.
     * @param timeoutMs Maximum time to wait in milliseconds.
     * @throws {WhatsAppError} If connection is not established within timeout.
     */
    private async waitIfOffline(timeoutMs: number = 30000): Promise<void> {
        const start = Date.now();
        while (this.whatsappService.getStatus() !== 'connected') {
            if (Date.now() - start > timeoutMs) {
                throw new WhatsAppError('TIMEOUT', t('message.sender.timeout'));
            }
            await this.sleep(1000);
        }
    }

    /**
     * Sends a message with retry logic and connection awareness.
     * @param request The message recipient and content.
     * @returns Promise resolving to a result object indicating success or failure.
     */
    public async send(request: MessageRequest): Promise<MessageResult> {
        const isGroup = request.recipientJid.endsWith('@g.us');
        // Groups need more retries because the first send bootstraps
        // the Signal sender-key session (causes "No sessions" on first attempts)
        const maxRetries = isGroup ? 5 : (request.options?.maxRetries ?? 3);
        let attempts = 0;
        let lastError: unknown = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                // 1. Ensure we are online
                await this.waitIfOffline();
                
                // 2. Get active socket
                const socket = this.whatsappService.getSocket();
                if (!socket) {
                    throw new WhatsAppError('SOCKET_NOT_INIT', t('message.sender.socketNotInitialized'));
                }

                // 3. Force refresh group metadata for groups before every send attempt
                // This ensures fresh participant list and sender keys
                if (isGroup) {
                    await this.whatsappService.prepareGroupSession(request.recipientJid, true);
                }

                // 5. Send the message
                // Note: Branding π is applied here to ensure consistency
                const text = this.whatsappService.getBrandVisibility() ? `${request.text} π` : request.text;
                const messageOptions: any = { text };
                // Forward useCachedGroupMetadata if provided in options
                if (request.options?.useCachedGroupMetadata !== undefined) {
                    messageOptions.useCachedGroupMetadata = request.options.useCachedGroupMetadata;
                }
                const response = await socket.sendMessage(request.recipientJid, messageOptions);

                fileLog(`SUCCESS sending to ${request.recipientJid} on attempt ${attempts}`);
                return {
                    success: true,
                    messageId: response?.key?.id,
                    attempts
                };
            } catch (error: unknown) {
                lastError = error;
                console.error(t('message.sender.attemptFailed', {
                    attempt: attempts,
                    recipientJid: request.recipientJid,
                    error: error instanceof Error ? error.message : String(error)
                }));
                
                // Specific handling for non-retryable errors
                if (error instanceof WhatsAppError && error.code === 'TIMEOUT') {
                    break;
                }

                // 5. Backoff before retry
                if (attempts < maxRetries) {
                    const message = error instanceof Error ? error.message : String(error);
                    const isNoSessions = message.includes('No sessions');
                    const backoff = isGroup && !isNoSessions ? 5000 : 1000;
                    const delay = Math.pow(2, attempts) * backoff;

                    if (this.whatsappService.isVerbose()) {
                        this.logger?.info(t('message.sender.retrying', { backoff: delay }));
                    }
                    await this.sleep(delay);
                }
            }
        }

        return {
            success: false,
            error: lastError instanceof Error ? lastError.message : t('message.sender.unknownError'),
            attempts
        };
    }

    /**
     * Send a media message (image, video, document) to a JID.
     */
    public async sendMedia(
        recipientJid: string,
        mediaPath: string,
        type: 'image' | 'video' | 'document',
        caption?: string
    ): Promise<MessageResult> {
        const isGroup = recipientJid.endsWith('@g.us');
        let attempts = 0;
        const maxRetries = isGroup ? 3 : 2;

        while (attempts < maxRetries) {
            attempts++;
            try {
                await this.waitIfOffline();
                const socket = this.whatsappService.getSocket();
                if (!socket) throw new WhatsAppError('SOCKET_NOT_INIT', t('message.sender.socketNotInitialized'));

                if (isGroup) {
                    await this.whatsappService.prepareGroupSession(recipientJid, true);
                }

                const buffer = readFileSync(mediaPath);
                const content: any = {};
                content[type] = buffer;
                if (caption) content.caption = caption;

                const response = await socket.sendMessage(recipientJid, content);
                fileLog(`SUCCESS sending ${type} to ${recipientJid} on attempt ${attempts}`);
                return { success: true, messageId: response?.key?.id, attempts };
            } catch (error) {
                console.error(`[MessageSender] ${type} send attempt ${attempts} failed:`, error instanceof Error ? error.message : String(error));
                if (attempts < maxRetries) await this.sleep(Math.pow(2, attempts) * 1000);
            }
        }
        return { success: false, error: `Failed to send ${type} after ${maxRetries} attempts`, attempts };
    }

    /**
     * Add participants to a WhatsApp group.
     */
    public async addGroupParticipants(
        groupJid: string,
        participantJids: string[]
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const socket = this.whatsappService.getSocket();
            if (!socket) throw new WhatsAppError('SOCKET_NOT_INIT', t('message.sender.socketNotInitialized'));

            // Ensure JIDs have @s.whatsapp.net suffix
            const normalized = participantJids.map(jid => 
                jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
            );

            await socket.groupParticipantsUpdate(groupJid, normalized, 'add');
            fileLog(`SUCCESS adding ${normalized.length} participants to ${groupJid}`);
            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            fileLog(`FAILED adding participants to ${groupJid}: ${msg}`);
            return { success: false, error: msg };
        }
    }

    /**
     * Remove participants from a WhatsApp group.
     */
    public async removeGroupParticipants(
        groupJid: string,
        participantJids: string[]
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const socket = this.whatsappService.getSocket();
            if (!socket) throw new WhatsAppError('SOCKET_NOT_INIT', t('message.sender.socketNotInitialized'));

            const normalized = participantJids.map(jid => 
                jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
            );

            await socket.groupParticipantsUpdate(groupJid, normalized, 'remove');
            fileLog(`SUCCESS removing ${normalized.length} participants from ${groupJid}`);
            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            fileLog(`FAILED removing participants from ${groupJid}: ${msg}`);
            return { success: false, error: msg };
        }
    }
}
