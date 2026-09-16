import {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeWASocket
} from 'baileys';
import { appendFileSync } from 'fs';
import P from 'pino';
import { t } from '../i18n.js';
import { IncomingMessage, MessageResult, SessionStatus } from '../models/whatsapp.types.js';
import { installBaileysConsoleFilter } from './baileys-console-filter.js';
import { ContactsService } from './contacts.service.js';
import { MessageSender } from './message.sender.js';
import { SessionManager } from './session.manager.js';
import { createStoragePaths } from './storage-path.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';

const LOG_FILE = createStoragePaths().logPath;
function fileLog(msg: string) {
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [WhatsApp-Pi] ${msg}\n`); } catch {
        // File logging is best-effort.
    }
}

export interface WhatsAppStartOptions {
    allowPairingOnAuthFailure?: boolean;
}

interface DisconnectPayload {
    error?: unknown;
}

interface ConnectionUpdateEvent {
    connection?: 'close' | 'open' | string;
    lastDisconnect?: DisconnectPayload;
    qr?: string;
}

interface IncomingMessageKey {
    id?: string;
    remoteJid?: string;
    fromMe?: boolean;
    participant?: string;
}

interface IncomingMessageContextInfo {
    mentionedJid?: string[];
}

interface IncomingMessageWithContext {
    contextInfo?: IncomingMessageContextInfo;
}

interface IncomingMessageContent {
    conversation?: string;
    extendedTextMessage?: {
        text?: string;
        contextInfo?: IncomingMessageContextInfo;
    };
    imageMessage?: IncomingMessageWithContext;
    videoMessage?: IncomingMessageWithContext;
    documentMessage?: IncomingMessageWithContext;
    audioMessage?: IncomingMessageWithContext;
    stickerMessage?: IncomingMessageWithContext;
    buttonsMessage?: IncomingMessageWithContext;
    templateMessage?: IncomingMessageWithContext;
}

interface IncomingMessageLike {
    key: IncomingMessageKey;
    message?: IncomingMessageContent;
    pushName?: string;
    messageTimestamp?: number | string;
}

interface MessagesUpsertEvent {
    messages?: IncomingMessageLike[];
}

/** Baileys v7 Contact type — see https://github.com/whiskeysockets/baileys/blob/master/src/Types/Contact.ts */
interface BaileysContact {
	id: string;
	lid?: string;
	phoneNumber?: string;
	name?: string;
	notify?: string;
	username?: string;
	verifiedName?: string;
	imgUrl?: string | null;
	status?: string;
}

/** Baileys v7 GroupMetadata subset used by this service */
interface BaileysGroupMetadata {
    id: string;
    subject?: string;
    participants?: Array<{ id: string; phoneNumber?: string }>;
}

interface WhatsAppSocketLike {
    user?: { id?: string; lid?: string };
    ev: {
        on(event: 'connection.update', handler: (update: ConnectionUpdateEvent) => void | Promise<void>): void;
        on(event: 'creds.update', handler: () => void | Promise<void>): void;
        on(event: 'messages.upsert', handler: (payload: MessagesUpsertEvent) => void | Promise<void>): void;
        on(event: 'contacts.upsert', handler: (contacts: BaileysContact[]) => void | Promise<void>): void;
        on(event: 'contacts.update', handler: (contacts: Partial<BaileysContact>[]) => void | Promise<void>): void;
    on(event: 'groups.upsert', handler: (groups: BaileysGroupMetadata[]) => void | Promise<void>): void;
    on(event: 'groups.update', handler: (updates: Partial<BaileysGroupMetadata>[]) => void | Promise<void>): void;
    on(event: 'group-participants.update', handler: (update: { id: string; participants: unknown[]; action: string }) => void | Promise<void>): void;
on(event: 'messaging-history.set', handler: (event: { contacts?: BaileysContact[]; messages?: unknown[]; chats?: unknown[]; isLatest?: boolean }) => void | Promise<void>): void;
        removeAllListeners(event: 'connection.update' | 'creds.update' | 'messages.upsert'): void;
    };
    end(reason?: unknown): void;
    logout(): Promise<void>;
    sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string } } | undefined>;
    sendPresenceUpdate(presence: 'composing' | 'recording' | 'paused', jid: string): Promise<void>;
    readMessages(messages: Array<{ remoteJid: string; id: string; fromMe: boolean }>): Promise<void>;
    groupMetadata(jid: string): Promise<{ id: string; subject: string; participants: Array<{ id: string }> }>;
    groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string; participants: Array<{ id: string; phoneNumber?: string }> }>>;
    onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: boolean }[]>;
    groupParticipantsUpdate(jid: string, participants: string[], action: 'add' | 'remove' | 'demote' | 'promote'): Promise<any>;
    profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>;
}

interface LastDisconnectLike {
    error?: unknown;
}

interface BoomLikeError {
    output?: {
        statusCode?: number;
    };
    message?: string;
}

export class WhatsAppService {
    private logger?: WhatsAppPiLogger;
    private static readonly INITIAL_RECONNECT_DELAY_MS = 5_000;
    private static readonly MAX_RECONNECT_DELAY_MS = 120_000;

    private socket?: WhatsAppSocketLike;
    private sessionManager: SessionManager;
    private messageSender: MessageSender;
    private isReconnecting = false;
    private reconnectAttempts = 0;
    private verboseMode = false;
    private onIncomingMessageRecorded?: (message: IncomingMessage) => void | Promise<void>;
    private saveCreds?: () => Promise<void>;
    private restoreBaileysConsoleFilter?: () => void;
    private reconnectTimeout?: ReturnType<typeof setTimeout>;
    private intentionalStop = false;
    private onQRCode?: (qr: string) => void;
    private onMessage?: (m: MessagesUpsertEvent) => void;
    private onStatusUpdate?: (status: string) => void;
    private lastRemoteJid: string | null = null;
    private qrWasShown = false;
    private boundGroupJid: string | null = null;
    private groupMetadataCache: Map<string, { data: { id: string; subject: string; participants: Array<{ id: string }> }; timestamp: number }> = new Map();
    /** Real WhatsApp group names (subject) learned from groupMetadata / group events. */
    private groupSubjects: Map<string, string> = new Map();
    /** Outgoing message content store used by Baileys' getMessage callback (retry/resend). */
    private recentSentMessages: Map<string, unknown> = new Map();
    // Message IDs sent by THIS extension (tools/cron) — used to skip the
    // outgoing echo in the message handler so it never triggers a turn.
    private extensionSentIds: Set<string> = new Set();
    /** Retry-counter cache for failed message decryption (Baileys CacheStore contract). */
    private msgRetryCounterCache: Map<string, unknown> = new Map();
    /** Placeholder-resend cache for undecryptable messages (Baileys CacheStore contract). */
    private placeholderResendCache: Map<string, unknown> = new Map();
    private contactsService: ContactsService;

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
        this.messageSender = new MessageSender(this);
        this.contactsService = new ContactsService(createStoragePaths().contactsPath);
        void this.contactsService.load();
    }

    setLogger(logger: WhatsAppPiLogger) {
        this.logger = logger;
    }

    getLogger(): WhatsAppPiLogger | undefined {
        return this.logger;
    }

    public setGroupBinding(groupJid: string) {
        this.boundGroupJid = groupJid;
    }

    public getBoundGroupJid(): string | null {
        return this.boundGroupJid;
    }

    public getStatus(): SessionStatus {
        return this.sessionManager.getStatus();
    }

    public getEffectiveStatus(): SessionStatus {
        const status = this.sessionManager.getStatus();
        if (status === 'connected' && !this.socket) {
            return 'disconnected';
        }

        return status;
    }

    public getBrandVisibility(): boolean {
        return this.sessionManager.getBrandVisibility();
    }

    public getAgentSignature(): string {
        return this.sessionManager.getAgentSignature();
    }

    public setIncomingMessageRecorder(callback: (message: IncomingMessage) => void | Promise<void>) {
        this.onIncomingMessageRecorded = callback;
    }

    public getSocket(): WhatsAppSocketLike | undefined {
        return this.socket;
    }

    public getContactsService(): ContactsService {
        return this.contactsService;
    }

    public isVerbose(): boolean {
        return this.verboseMode;
    }

    public setVerboseMode(verbose: boolean) {
        this.verboseMode = verbose;
        if (verbose) {
            this.restoreBaileysConsoleFilter?.();
            this.restoreBaileysConsoleFilter = undefined;
        }
    }

    private normalizeContactNumber(value: string): string {
        if (value.startsWith('+')) {
            return value;
        }

        if (/^\d+$/.test(value)) {
            return `+${value}`;
        }

        return value;
    }

    private normalizeRecipientJid(jid: string): string {
        if (jid.includes('@')) return jid;
        const digits = jid.startsWith('+') ? jid.slice(1) : jid;
        return `${digits}@s.whatsapp.net`;
    }

    public resolveOutboundRecipientJid(recipient: string): string {
        if (SessionManager.isGroupJid(recipient)) {
            return recipient;
        }

        const senderNumber = this.normalizeContactNumber(recipient.split('@')[0]);
        const allowedContact = this.sessionManager.getAllowedContact(recipient)
            ?? this.sessionManager.getAllowedContact(senderNumber);

        if (allowedContact?.sendNumber) {
            return this.normalizeRecipientJid(allowedContact.sendNumber);
        }

        return this.normalizeRecipientJid(recipient);
    }

    private normalizeJidForComparison(jid: string): string {
        const [localPart, domain = ''] = jid.split('@');
        const normalizedLocal = localPart.split(':')[0];
        return domain ? `${normalizedLocal}@${domain}` : normalizedLocal;
    }

    private getDisconnectStatusCode(error: unknown): number | undefined {
        if (!error || typeof error !== 'object') {
            return undefined;
        }

        const candidate = error as BoomLikeError;
        return candidate.output?.statusCode;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        if (typeof error === 'object' && error !== null && 'message' in error) {
            const candidate = error as { message?: unknown };
            return typeof candidate.message === 'string' ? candidate.message : '';
        }

        return '';
    }

    private clearReconnectTimeout() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }

    private getReconnectDelayMs(): number {
        const delay = WhatsAppService.INITIAL_RECONNECT_DELAY_MS * (2 ** Math.max(0, this.reconnectAttempts - 1));
        return Math.min(delay, WhatsAppService.MAX_RECONNECT_DELAY_MS);
    }

    private scheduleReconnect(options: WhatsAppStartOptions) {
        if (this.intentionalStop) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = this.getReconnectDelayMs();
        this.onStatusUpdate?.(t('service.whatsapp.reconnecting'));
        this.clearReconnectTimeout();
        this.reconnectTimeout = setTimeout(async () => {
            this.isReconnecting = false;
            if (this.intentionalStop) return;
            try {
                await this.start(options);
            } catch {
                if (!this.intentionalStop) {
                    this.scheduleReconnect(options);
                }
            }
        }, delay);
    }

    private cleanupSocket() {
        this.clearReconnectTimeout();

        if (!this.socket) {
            return;
        }

        this.restoreBaileysConsoleFilter?.();
        this.restoreBaileysConsoleFilter = undefined;
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('messages.upsert');

        try {
            this.socket.end(undefined);
        } catch {
            // Best-effort cleanup
        }

        this.socket = undefined;
    }

    private setSocket(socket: WhatsAppSocketLike) {
        this.socket = socket;
    }

    private registerSocketListeners(socket: WhatsAppSocketLike, options: WhatsAppStartOptions, saveCreds: () => Promise<void>) {
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            await this.sessionManager.markAuthStateAvailable();
        });

        socket.ev.on('connection.update', async (update) => {
            await this.handleConnectionUpdate(update, options);
        });

        this.contactsService.attach(socket);

        // Live group metadata sync — Baileys docs recommend refreshing the
        // cachedGroupMetadata store on these events, otherwise group sessions
        // go stale and outgoing group messages fail to decrypt on recipients.
        socket.ev.on('groups.upsert', (groups) => {
            for (const group of groups) {
                this.applyGroupMetadata(group as BaileysGroupMetadata);
            }
        });

        socket.ev.on('groups.update', (updates) => {
            void this.handleGroupUpdates(updates);
        });

        socket.ev.on('group-participants.update', (update) => {
            void this.refreshGroupMetadata(update.id);
        });

        socket.ev.on('messages.upsert', (payload) => {
            void this.handleIncomingMessages(payload);
        });
    }

    /** Store a group metadata snapshot into the caches (subject + sender-key cache). */
    private applyGroupMetadata(metadata: BaileysGroupMetadata) {
        if (!metadata?.id) return;
        if (metadata.subject) {
            const previous = this.groupSubjects.get(metadata.id);
            if (previous !== metadata.subject) {
                this.groupSubjects.set(metadata.id, metadata.subject);
                this.syncStoredGroupAlias(metadata.id, metadata.subject, previous);
            }
        }
        this.groupMetadataCache.set(metadata.id, {
            data: metadata as { id: string; subject: string; participants: Array<{ id: string }> },
            timestamp: Date.now(),
        });
    }

    /**
     * Keep the locally stored group alias in sync with the real WhatsApp subject:
     * only overwrite when the alias was empty or equals the previous subject
     * (i.e. it was never a manually-set custom alias).
     */
    private syncStoredGroupAlias(groupJid: string, subject: string, previousSubject?: string) {
        try {
            const stored = this.sessionManager.getAllowedGroup(groupJid);
            if (!stored) return;
            if (!stored.name || stored.name === previousSubject) {
                void this.sessionManager.setAllowedGroupAlias(groupJid, subject);
            }
        } catch {
            // Alias sync is best-effort — never break group metadata handling.
        }
    }

    private async handleGroupUpdates(updates: Partial<BaileysGroupMetadata>[]) {
        for (const update of updates) {
            if (!update?.id) continue;
            // groups.update delivers partial metadata; refetch the full snapshot
            // so the sender-key cache stays complete (per Baileys documentation).
            const refreshed = await this.refreshGroupMetadata(update.id);
            if (!refreshed && update.subject) {
                this.applyGroupMetadata({ id: update.id, subject: update.subject });
            }
        }
    }

    /** Refetch full metadata for one group and refresh caches. Returns the subject when known. */
    private async refreshGroupMetadata(jid: string): Promise<string | undefined> {
        const socket = this.getActiveSocket();
        if (!socket || !jid.endsWith('@g.us')) return undefined;
        try {
            const metadata = await socket.groupMetadata(jid);
            this.applyGroupMetadata(metadata as BaileysGroupMetadata);
            return metadata?.subject;
        } catch (error) {
            if (this.verboseMode) {
                fileLog(`[WhatsApp-Pi] Failed to refresh group metadata for ${jid}: ${error instanceof Error ? error.message : String(error)}`);
            }
            return undefined;
        }
    }

    /** Fetch all groups the account participates in and sync names + metadata cache. */
    public async refreshGroupSubjects(): Promise<void> {
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            const groups = await socket.groupFetchAllParticipating();
            const values = Object.values(groups ?? {}) as BaileysGroupMetadata[];
            for (const group of values) {
                this.applyGroupMetadata(group);
            }
            if (this.verboseMode) {
                fileLog(`[WhatsApp-Pi] Synced ${values.length} group names from WhatsApp`);
            }
        } catch (error) {
            if (this.verboseMode) {
                fileLog(`[WhatsApp-Pi] Failed to sync group names: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** Fetch fresh metadata for one group (used when allowing a group from the UI). */
    public async fetchGroupSubject(jid: string): Promise<string | undefined> {
        return this.refreshGroupMetadata(jid);
    }

    /** Real WhatsApp group name (subject) when known. */
    public getGroupSubject(jid: string): string | undefined {
        return this.groupSubjects.get(jid);
    }

    /** Record an outgoing message so Baileys can resend it on retry requests. */
    public recordSentMessage(remoteJid: string, messageId: string | undefined, content: unknown) {
        if (!messageId) return;
        this.recentSentMessages.set(`${remoteJid}|${messageId}`, content);
        // Keep the store bounded — retries only concern recent messages.
        if (this.recentSentMessages.size > 200) {
            const firstKey = this.recentSentMessages.keys().next().value;
            if (firstKey !== undefined) this.recentSentMessages.delete(firstKey);
        }
    }

    /** True when this message was sent by this extension itself (echo skip). */
    public wasSentByExtension(remoteJid: string | undefined, messageId: string | undefined): boolean {
        if (!messageId) return false;
        if (this.extensionSentIds.has(messageId)) return true;
        return remoteJid !== undefined && this.extensionSentIds.has(`${remoteJid}|${messageId}`);
    }

    private rememberExtensionSent(remoteJid: string, messageId: string | undefined) {
        if (!messageId) return;
        this.extensionSentIds.add(messageId);
        this.extensionSentIds.add(`${remoteJid}|${messageId}`);
        // Bounded: echoes only arrive within seconds of the send.
        if (this.extensionSentIds.size > 400) {
            const it = this.extensionSentIds.values();
            for (let i = 0; i < 200; i++) {
                const v = it.next().value;
                if (v === undefined) break;
                this.extensionSentIds.delete(v);
            }
        }
    }

    private async createSocket(): Promise<WhatsAppSocketLike> {
        const { state, saveCreds } = await this.sessionManager.getAuthState();
        this.saveCreds = saveCreds;
        const { version } = await fetchLatestBaileysVersion();

        const logger = P({ level: this.verboseMode ? 'trace' : 'silent' });

        const groupMetadataCache = this.groupMetadataCache;

        const socket = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            syncFullHistory: false,
            logger,
            // Linked-device reliability: without these, undecryptable messages stay
            // stuck as "waiting for this message" on recipients' devices.
            markOnlineOnConnect: false,
            enableAutoSessionRecreation: true,
            enableRecentMessageCache: true,
            msgRetryCounterCache: {
                get: (key: string) => this.msgRetryCounterCache.get(key) as any,
                set: (key: string, value: unknown) => {
                    this.msgRetryCounterCache.set(key, value);
                },
                del: (key: string) => {
                    this.msgRetryCounterCache.delete(key);
                },
                flushAll: () => {
                    this.msgRetryCounterCache.clear();
                },
            },
            placeholderResendCache: {
                get: (key: string) => this.placeholderResendCache.get(key) as any,
                set: (key: string, value: unknown) => {
                    this.placeholderResendCache.set(key, value);
                },
                del: (key: string) => {
                    this.placeholderResendCache.delete(key);
                },
                flushAll: () => {
                    this.placeholderResendCache.clear();
                },
            },
            getMessage: async (key: { remoteJid?: string | null; id?: string | null }) => {
                const storeKey = `${key.remoteJid ?? ''}|${key.id ?? ''}`;
                return this.recentSentMessages.get(storeKey) as any;
            },
            cachedGroupMetadata: async (jid: string) => {
                const entry = groupMetadataCache.get(jid);
                return entry?.data as any;
            }
        }) as WhatsAppSocketLike;

        return socket;
    }

    async start(options: WhatsAppStartOptions = {}) {
        this.intentionalStop = false;
        if (this.isReconnecting) return;
        this.onStatusUpdate?.(t('service.whatsapp.connecting'));

        this.cleanupSocket();

        const originalConsoleLog = console.log;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;
        let socketInitialized = false;

        if (!this.verboseMode) {
            console.log = () => {};
            console.warn = () => {};
            console.error = () => {};
        }

        try {
            const socket = await this.createSocket();
            this.setSocket(socket);
            this.registerSocketListeners(socket, options, this.saveCreds ?? (async () => {}));
            socketInitialized = true;
        } catch (error) {
            if (!this.verboseMode) {
                console.log = originalConsoleLog;
                console.warn = originalConsoleWarn;
                console.error = originalConsoleError;
            }
            throw error;
        } finally {
            if (!this.verboseMode) {
                console.log = originalConsoleLog;
                console.warn = originalConsoleWarn;
                console.error = originalConsoleError;
                if (socketInitialized) {
                    this.restoreBaileysConsoleFilter = installBaileysConsoleFilter(this.verboseMode);
                }
            }
        }
    }

    private async handleConnectionUpdate(update: ConnectionUpdateEvent, options: WhatsAppStartOptions) {
        const { connection, lastDisconnect, qr } = update;
        const allowPairingOnAuthFailure = options.allowPairingOnAuthFailure ?? true;

        if (qr) {
            await this.handlePairingQr(qr);
        }

        if (connection === 'close') {
            await this.handleConnectionClosed(lastDisconnect, allowPairingOnAuthFailure, options);
            return;
        }

        if (connection === 'open') {
            await this.handleConnectionOpen();
        }
    }

    private async handlePairingQr(qr: string) {
        await this.sessionManager.setStatus('pairing');
        this.onQRCode?.(qr);
        this.onStatusUpdate?.(t('service.whatsapp.typeToConnect'));
        this.qrWasShown = true;
    }

    private async handleConnectionOpen() {
        if (this.verboseMode) {
            fileLog(t('service.whatsapp.connectionOpened'));
        }

        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.clearReconnectTimeout();
        await this.saveCreds?.();
        await this.sessionManager.markAuthStateAvailable();
        await this.sessionManager.setStatus('connected');
        this.onStatusUpdate?.(t('service.whatsapp.connected'));

        // Sync real group names (subjects) right after connecting so display
        // never falls back to stale/incorrect local aliases.
        void this.refreshGroupSubjects();

        if (this.qrWasShown) {
            this.qrWasShown = false;
            fileLog(t('service.whatsapp.qrConnected'));
            fileLog(t('service.whatsapp.qrWelcomeMessage'));
            void this.sendQrWelcome();
        }
    }

    private async sendQrWelcome(): Promise<void> {
        const rawId = this.socket?.user?.id;
        if (!rawId) return;
        const selfJid = this.normalizeJidForComparison(rawId);
        await this.sessionManager.setOperatorJid(selfJid);
        // Send the operator welcome reminder only once per install — it was
        // re-spamming on every QR reconnect.
        if (this.sessionManager.hasSentQrWelcome()) return;
        try {
            await this.socket?.sendMessage(selfJid, { text: t('service.whatsapp.qrWelcomeMessage') });
            await this.sessionManager.markQrWelcomeSent();
        } catch {
            // Best-effort — welcome send failure must not abort the session.
        }
    }

    public getOperatorJid(): string {
        return this.sessionManager.getOperatorJid();
    }

    private isBadMacError(errorMessage: string): boolean {
        return errorMessage.includes('Bad MAC');
    }

    private isAuthRejected(statusCode: number | undefined, errorMessage: string): boolean {
        return errorMessage.includes('bad-request')
            || statusCode === 400
            || statusCode === 401
            || statusCode === DisconnectReason.loggedOut
            || statusCode === DisconnectReason.badSession;
    }

    private async handleConnectionClosed(
        lastDisconnect: LastDisconnectLike | undefined,
        allowPairingOnAuthFailure: boolean,
        options: WhatsAppStartOptions
    ) {
        const statusCode = this.getDisconnectStatusCode(lastDisconnect?.error);
        const errorMessage = this.getErrorMessage(lastDisconnect?.error);
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const isBadMac = this.isBadMacError(errorMessage);
        const isAuthRejected = this.isAuthRejected(statusCode, errorMessage);
        const shouldTreatAsLoggedOut = isBadMac || isAuthRejected;

        if (this.intentionalStop) {
            return;
        }

        if (this.verboseMode) {
            fileLog(t('service.whatsapp.connectionClosed', { statusCode: statusCode ?? 'unknown', shouldReconnect: String(shouldReconnect) }));
        }

        if (shouldTreatAsLoggedOut) {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.sessionRejected', { statusCode: statusCode ?? 'unknown' }));
            }
            if (isBadMac) {
                if (this.verboseMode) {
					fileLog(t('service.whatsapp.badMacDetected'));
                    fileLog(t('service.whatsapp.runClearAuth'));
                }
                this.onStatusUpdate?.(t('service.whatsapp.sessionErrorBadMac'));
            } else if (isAuthRejected && allowPairingOnAuthFailure) {
                this.onStatusUpdate?.('| WhatsApp: Session Preserved (Reconnect Failed)');
            }
            this.cleanupSocket();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            await this.sessionManager.setStatus('disconnected');
            if (!isBadMac) {
                this.onStatusUpdate?.(t('service.whatsapp.disconnected'));
            }
            return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.connectionReplaced'));
            }
            this.cleanupSocket();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            await this.sessionManager.setStatus('disconnected');
            this.onStatusUpdate?.(t('service.whatsapp.conflict'));
            return;
        }

        if (shouldReconnect && !this.isReconnecting) {
            await this.saveCreds?.();
            this.cleanupSocket();
            this.scheduleReconnect(options);
        } else if (!shouldReconnect) {
            this.reconnectAttempts = 0;
            await this.sessionManager.setStatus('logged-out');
            this.onStatusUpdate?.(t('service.whatsapp.disconnected'));
        }
    }

    private extractText(message: IncomingMessageContent | undefined): string {
        return message?.conversation || message?.extendedTextMessage?.text || '';
    }

    private isPiGeneratedMessage(text: string): boolean {
        const signature = this.sessionManager.getAgentSignature();
        if (!signature) return false;
        return text.endsWith(signature);
    }

    private getIncomingTimestamp(timestamp: number | string | undefined): number {
        if (typeof timestamp === 'number') {
            return timestamp;
        }

        if (typeof timestamp === 'string') {
            const parsed = Number(timestamp);
            return Number.isFinite(parsed) ? parsed : Date.now();
        }

        return Date.now();
    }

    private async recordIncomingMessage(message: IncomingMessageLike, remoteJid: string, text: string) {
        void Promise.resolve(this.onIncomingMessageRecorded?.({
            id: message.key.id ?? remoteJid,
            remoteJid,
            pushName: message.pushName || undefined,
            text,
            timestamp: this.getIncomingTimestamp(message.messageTimestamp)
        })).catch(error => {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.failedRecordRecentMessage') + ' ' + error);
            }
        });
    }

    public async handleIncomingMessages(payload: MessagesUpsertEvent) {
        fileLog(`[DEBUG] handleIncomingMessages called, status=${this.sessionManager.getStatus()}`);
        if (this.sessionManager.getStatus() !== 'connected') return;

        const message = payload.messages?.[0];
        if (!message || !message.key.remoteJid) {
            fileLog(`[DEBUG] No message or remoteJid`);
            return;
        }

        const remoteJid = message.key.remoteJid;
        fileLog(`[DEBUG] Message from remoteJid=${remoteJid}, fromMe=${message.key.fromMe}`);

        // Skip messages sent by the operator to OTHER contacts.
        // Allow fromMe when remoteJid is in allowList or updateList (linked devices / LID).
        if (message.key.fromMe) {
            const isGroup = remoteJid.endsWith('@g.us');
            const isAllowed = isGroup
                ? this.sessionManager.isAllowedGroup(remoteJid)
                : this.sessionManager.isConversationAllowed(
                      this.normalizeContactNumber(remoteJid.split('@')[0])
                  );
            const isUpdateTarget = await this.sessionManager.isAllowedUpdateTarget(remoteJid);
            fileLog(`[DEBUG] fromMe: remoteJid=${remoteJid}, isGroup=${isGroup}, isAllowed=${isAllowed}, isUpdateTarget=${isUpdateTarget}`);
            if (!isAllowed && !isUpdateTarget) return;
        }

        const text = this.extractText(message.message);
        if (this.isPiGeneratedMessage(text)) {
            fileLog(`[DEBUG] Skipped: isPiGeneratedMessage`);
            return;
        }
        const isGroup = remoteJid.endsWith('@g.us');

        if (this.boundGroupJid) {
            // Group-only mode narrows the source before allow-list checks run.
            if (remoteJid !== this.boundGroupJid) return;
        }

        // Eagerly cache group metadata on incoming messages so it's
        // available for sender-key encryption when we reply
        if (isGroup) {
            void this.prepareGroupSession(remoteJid);
        }

        const senderJid = isGroup
            ? remoteJid
            : this.normalizeContactNumber(remoteJid.split('@')[0]);
        fileLog(`[DEBUG] senderJid=${senderJid}, isGroup=${isGroup}`);
        void this.recordIncomingMessage(message, remoteJid, text);

        const pushName = message.pushName || undefined;

        if (this.boundGroupJid) {
            if (!this.sessionManager.isAllowedGroup(this.boundGroupJid)) {
                fileLog(`[DEBUG] Group not allowed: ${this.boundGroupJid}`);
                await this.sessionManager.trackIgnoredNumber(this.boundGroupJid, pushName);
                return;
            }

            this.lastRemoteJid = remoteJid;
            fileLog(`[DEBUG] Calling onMessage (group mode)`);
            this.onMessage?.(payload);
            return;
        }

        if (!this.sessionManager.isConversationAllowed(senderJid)) {
            fileLog(`[DEBUG] NOT allowed: ${senderJid}`);
            await this.sessionManager.trackIgnoredNumber(senderJid, pushName);
            return;
        }

        fileLog(`[DEBUG] Calling onMessage (direct mode), senderJid=${senderJid}`);
        this.lastRemoteJid = remoteJid;
        this.onMessage?.(payload);
    }

    setQRCodeCallback(callback: (qr: string) => void) {
        this.onQRCode = callback;
    }

    setMessageCallback(callback: (m: MessagesUpsertEvent) => void) {
        this.onMessage = callback;
    }

    setStatusCallback(callback: (status: string) => void) {
        this.onStatusUpdate = callback;
    }

    public getLastRemoteJid(): string | null {
        return this.lastRemoteJid;
    }

    private getActiveSocket(): WhatsAppSocketLike | null {
        if (!this.socket || this.getStatus() !== 'connected') {
            return null;
        }

        return this.socket;
    }

    /**
     * Pre-loads group metadata into the cache for Baileys' cachedGroupMetadata.
     * This ensures Baileys can resolve group participants for Signal
     * sender-key encryption, preventing "No sessions" errors.
     */
    public async prepareGroupSession(jid: string, forceRefresh = false): Promise<void> {
        if (!jid.endsWith('@g.us')) return;
        const now = Date.now();
        const cached = this.groupMetadataCache.get(jid);
        // Refresh if not cached, stale (>5 min), or forced
        if (cached && !forceRefresh && (now - cached.timestamp) < 5 * 60 * 1000) {
            fileLog(`Group metadata cache HIT for ${jid} (${cached.data.participants?.length ?? 0} participants, age ${Math.round((now - cached.timestamp) / 1000)}s)`);
            return;
        }
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            fileLog(`Fetching group metadata for ${jid}...`);
            const metadata = await socket.groupMetadata(jid);
            this.groupMetadataCache.set(jid, { data: metadata, timestamp: now });
            const participantJids = metadata.participants?.map((p: any) => p.id || p.jid).filter(Boolean) ?? [];
            fileLog(`Cached group metadata for ${jid} (${participantJids.length} participants: ${participantJids.join(', ')})`)
        } catch (error) {
            fileLog(`FAILED to fetch group metadata for ${jid}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async sendMessage(jid: string, text: string) {
        const recipientJid = this.resolveOutboundRecipientJid(jid);
        const isGroup = SessionManager.isGroupJid(recipientJid);
        fileLog(`[sendMessage] jid=${jid} → recipientJid=${recipientJid}, isGroup=${isGroup}, status=${this.getStatus()}`);

        await this.sendPresence(recipientJid, 'composing');

        const result = await this.messageSender.send({
            recipientJid,
            text: text,
            options: {
                useCachedGroupMetadata: false
            }
        });

        fileLog(`[sendMessage] Result: success=${result.success}, error=${result.error}, attempts=${result.attempts}`);
        await this.sendPresence(recipientJid, 'paused');

        if (result.success) {
            this.rememberExtensionSent(recipientJid, result.messageId);
        } else {
            fileLog(t('service.whatsapp.failedSendMessage', { jid: recipientJid, error: result.error ?? t('message.sender.unknownError') }));
        }

        return result;
    }

    async sendMenuMessage(jid: string, text: string) {
        const normalizedJid = this.resolveOutboundRecipientJid(jid);
        const socket = this.getActiveSocket();

        if (!socket) {
            return {
                success: false,
                error: t('service.whatsapp.notConnected'),
                attempts: 0
            };
        }

        const isGroup = SessionManager.isGroupJid(normalizedJid);

const messageOptions: any = { text };

        try {
            await this.sendPresence(normalizedJid, 'composing');
            const response = await socket.sendMessage(normalizedJid, messageOptions);
            await this.sendPresence(normalizedJid, 'paused');
            this.recordSentMessage(normalizedJid, response?.key?.id, messageOptions);

            return {
                success: true,
                messageId: response?.key?.id,
                attempts: 1
            };
        } catch (error: unknown) {
            await this.sendPresence(normalizedJid, 'paused');
            fileLog(t('service.whatsapp.failedSendMenuMessage', { jid: normalizedJid }) + ' ' + error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                attempts: 1
            };
        }
    }

    async sendPresence(jid: string, presence: 'composing' | 'recording' | 'paused') {
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            await socket.sendPresenceUpdate(presence, jid);
        } catch (error) {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.failedPresenceUpdate', { jid }) + ' ' + error);
            }
        }
    }

    async markRead(jid: string, messageId: string, fromMe: boolean = false) {
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            await socket.readMessages([{ remoteJid: jid, id: messageId, fromMe }]);
        } catch (error) {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.failedMarkRead') + ' ' + error);
            }
        }
    }

    async logout() {
        this.intentionalStop = true;
        // Try to logout via socket, but don't fail if socket is already closed
        try {
            await this.socket?.logout();
        } catch (error) {
            fileLog(`[WhatsApp-Pi] logout socket call failed (likely already disconnected): ${error}`);
        }
        // Always delete auth state so user can re-pair with QR
        try {
            await this.sessionManager.deleteAuthState();
        } catch (error) {
            fileLog(`[WhatsApp-Pi] deleteAuthState failed: ${error}`);
        }
    }

    async stop() {
        this.intentionalStop = true;
        try {
            await this.saveCreds?.();
        } catch (error) {
            if (this.verboseMode) {
                fileLog(t('service.whatsapp.failedPersistAuthState') + ' ' + error);
            }
        }

        this.cleanupSocket();
        this.isReconnecting = false;
        await this.sessionManager.setStatus('disconnected');
        this.onStatusUpdate?.(t('service.whatsapp.disconnected'));
    }

    /**
     * Send a media message (image, video, document) to a JID.
     */
    public async sendMediaMessage(
        recipientJid: string,
        mediaPath: string,
        type: 'image' | 'video' | 'document',
        caption?: string
    ): Promise<MessageResult> {
        const result = await this.messageSender.sendMedia(recipientJid, mediaPath, type, caption);
        if (result.success) {
            this.rememberExtensionSent(recipientJid, result.messageId);
        }
        return result;
    }

    /**
     * Add participants to a WhatsApp group.
     */
    public async addGroupParticipants(
        groupJid: string,
        participantJids: string[]
    ): Promise<{ success: boolean; error?: string }> {
        return this.messageSender.addGroupParticipants(groupJid, participantJids);
    }

    /**
     * Remove participants from a WhatsApp group.
     */
    public async removeGroupParticipants(
        groupJid: string,
        participantJids: string[]
    ): Promise<{ success: boolean; error?: string }> {
        return this.messageSender.removeGroupParticipants(groupJid, participantJids);
    }
}
