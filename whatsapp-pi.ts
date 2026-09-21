import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { initI18n, t } from "./src/i18n.js";
import { AudioService } from "./src/services/audio.service.js";
import { IncomingMediaService } from "./src/services/incoming-media.service.js";
import { extractIncomingText } from "./src/services/incoming-message.resolver.js";
import { ReactionSender } from "./src/services/reaction.sender.js";
import { RecentsService } from "./src/services/recents.service.js";
import { SessionManager } from "./src/services/session.manager.js";
import { WhatsAppPiLogger } from "./src/services/whatsapp-pi.logger.js";
import { WhatsAppService } from "./src/services/whatsapp.service.js";
import { MenuHandler } from "./src/ui/menu.handler.js";

// --- Extension Context Mode Helpers ---
// Determines if Pi is running in an interactive mode where long-lived connections
// (WhatsApp, Telegram) should be established. Passive modes (json, print) are for
// one-shot commands and should not start background services.

/** Pi runtime execution modes. */
type ExtensionRunMode = "tui" | "rpc" | "json" | "print";

/** Check if a value is a valid Pi run mode. */
function isExtensionRunMode(value: unknown): value is ExtensionRunMode {
	return (
		value === "tui" || value === "rpc" || value === "json" || value === "print"
	);
}

/**
 * Extract the Pi run mode from an extension context.
 * Returns undefined if mode cannot be determined.
 */
function getExtensionRunMode(ctx: unknown): ExtensionRunMode | undefined {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	const mode = (ctx as { mode?: unknown }).mode;
	return isExtensionRunMode(mode) ? mode : undefined;
}

/**
 * Check if Pi is running in a passive (non-interactive) mode.
 * Passive modes: "json", "print" — used for one-shot commands, scripting, CI.
 * In these modes, extensions should NOT start background connections/polling.
 */
function isPassiveRunMode(ctx: unknown): boolean {
	const mode = getExtensionRunMode(ctx);
	return mode === "json" || mode === "print";
}

/**
 * Check if WhatsApp/Telegram polling should start in the current context.
 * Returns true for interactive modes ("tui", "rpc"), false for passive modes.
 * Use this to guard auto-connect logic on extension startup.
 */
function shouldStartPolling(ctx: unknown): boolean {
	return !isPassiveRunMode(ctx);
}

/**
 * Parse a WhatsApp JID into its user / device / server parts (Baileys v7 LID-aware).
 * Handles both `number:device@server` and LID participant forms like `num.0:12@lid`.
 */
function parseJid(jid: string): {
	user: string;
	device?: number;
	server: string;
	isLid: boolean;
} {
	if (!jid || !jid.includes("@")) {
		return { user: jid ?? "", server: "", isLid: false };
	}
	const [local = "", server = ""] = jid.split("@");
	const [main = "", deviceRaw] = local.split(":");
	const parts = main.split(".");
	const user = parts[0] || "";
	// Baileys jidDecode: the device is the segment after ':' (e.g. `num:44@s.whatsapp.net`).
	// Some LID JIDs also carry a `.N` suffix (`num.0:12@lid`) — used as fallback only.
	let device: number | undefined =
		deviceRaw !== undefined ? Number.parseInt(deviceRaw, 10) : undefined;
	if (device === undefined || !Number.isFinite(device)) {
		device = undefined;
		const tail =
			parts.length > 1 ?
				Number.parseInt(parts[parts.length - 1]!, 10)
			:	Number.NaN;
		if (Number.isFinite(tail)) device = tail;
	}
	return { user, device, server, isLid: server.includes("lid") };
}

/**
 * Human-readable label for a message sent by the account owner (fromMe=true).
 * Baileys puts the sending device in the JID: 0 is the primary phone, other
 * numbers are linked devices (this extension session included).
 */
function describeSelfDevice(
	device: number | undefined,
	selfDevice: number | undefined,
): string {
	if (device === undefined) return "you";
	if (selfDevice !== undefined && device === selfDevice) {
		return "you, from this assistant (extension)";
	}
	if (device === 0) return "you, from your phone";
	return `you, from your linked device #${device}`;
}

const shutdownState = globalThis as typeof globalThis & {
	__whatsappPiShutdown?: {
		installed: boolean;
		stop?: () => Promise<void>;
	};
};

export default function (pi: ExtensionAPI) {
	initI18n(pi);

	// Register verbose flag
	pi.registerFlag("verbose", {
		description: "Enable verbose mode (show Baileys trace logs)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("whatsapp-pi-online", {
		description: "Enable WhatsApp-Pi on startup",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("whatsapp-group", {
		description:
			"Bind this agent to a specific WhatsApp group JID (e.g. 120363012345@g.us). When set, only messages from this group are processed.",
		type: "string",
		default: "",
	});

	// Render outgoing echoes (Ben's own replies) as plain muted text so they are
	// visible in the chat without looking like an incoming message that needs a reply.
	pi.registerMessageRenderer("whatsapp-echo", (message, _options, theme) => {
		const text =
			typeof message.content === "string" ?
				message.content
			:	message.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
		return new Text(theme.fg("muted", text), 0, 0);
	});

	// Same muted rendering for appended echo entries (appendEntry path).
	// Entries are TUI-only: displayed immediately, never trigger a turn,
	// never enter LLM context (the assistant already knows what it sent).
	pi.registerEntryRenderer("whatsapp-echo", (entry, _opts, theme) => {
		const data = entry.data as { content?: string };
		return new Text(theme.fg("muted", data?.content ?? ""), 0, 0);
	});

	const sessionManager = new SessionManager();
	const whatsappService = new WhatsAppService(sessionManager);
	const recentsService = new RecentsService(sessionManager);
	const logger = new WhatsAppPiLogger(false);
	const audioService = new AudioService(logger);
	const incomingMediaService = new IncomingMediaService(audioService, logger);
	const menuHandler = new MenuHandler(
		whatsappService,
		sessionManager,
		recentsService,
	);
	let _ctx: ExtensionContext | undefined;

	const formatFooterStatus = (status: string) => {
		if (status !== t("service.whatsapp.connected")) {
			return status;
		}

		const allowedChats =
			sessionManager.getAllowList().length +
			sessionManager.getAllowedGroups().length;
		if (allowedChats === 0) {
			return `${status} - No chats`;
		}

		return `${status} to ${allowedChats} chat${allowedChats === 1 ? "" : "s"}`;
	};

	const refreshFooterStatus = () => {
		if (!_ctx) return;
		_ctx.ui.setStatus(
			"whatsapp",
			formatFooterStatus(
				whatsappService.getStatus() === "connected" ?
					t("service.whatsapp.connected")
				:	t("service.whatsapp.disconnected"),
			),
		);
	};

	const installGracefulShutdownHandlers = () => {
		shutdownState.__whatsappPiShutdown ??= { installed: false };
		if (shutdownState.__whatsappPiShutdown.installed) {
			return;
		}

		shutdownState.__whatsappPiShutdown.installed = true;

		const shutdown = async (reason: string) => {
			try {
				await shutdownState.__whatsappPiShutdown?.stop?.();
			} catch (error) {
				logger.error(
					`[WhatsApp-Pi] Graceful shutdown failed during ${reason}:`,
					error,
				);
			}
		};

		process.once("SIGINT", () => {
			void shutdown("SIGINT");
		});
		process.once("SIGTERM", () => {
			void shutdown("SIGTERM");
		});
	};

	// Initial status setup
	pi.on("session_start", async (_event, ctx) => {
		_ctx = ctx;
		// Check verbose mode
		const isVerboseFlagSet = process.argv.includes("--verbose");

		const isVerbose = isVerboseFlagSet;

		whatsappService.setVerboseMode(isVerbose);
		logger.setVerbose(isVerbose);

		if (isVerbose) {
			logger.log(
				"[WhatsApp-Pi] Verbose mode enabled - Baileys trace logs will be shown",
			);
		}
		ctx.ui.setStatus("whatsapp", "| WhatsApp: Disconnected");
		whatsappService.setStatusCallback((status) => {
			ctx.ui.setStatus("whatsapp", formatFooterStatus(status));
		});

		// Set up group binding if configured
		const boundGroupJid = (pi.getFlag("whatsapp-group") as string) || "";
		if (boundGroupJid) {
			whatsappService.setGroupBinding(boundGroupJid);
			sessionManager.setGroupJidForAuth(boundGroupJid);
			logger.log(`[WhatsApp-Pi] Group-only mode: bound to ${boundGroupJid}`);
		}

		await sessionManager.ensureInitialized();
		await recentsService.ensureInitialized();
		installGracefulShutdownHandlers();
		shutdownState.__whatsappPiShutdown = {
			installed: shutdownState.__whatsappPiShutdown?.installed ?? false,
			stop: async () => {
				await whatsappService.stop();
			},
		};
		whatsappService.setIncomingMessageRecorder(async (message) => {
			const isGroup = message.remoteJid.endsWith("@g.us");
			const senderNumber =
				isGroup ? message.remoteJid : `+${message.remoteJid.split("@")[0]}`;
			await recentsService.recordMessage({
				messageId: message.id,
				senderNumber,
				// For groups, pushName is the *participant* who sent the message,
				// not the group's name — storing it polluted the group display
				// name ("Ben sent to Ben (group)"). Use the real subject instead.
				senderName:
					isGroup ?
						whatsappService.getGroupSubject(message.remoteJid)
					:	message.pushName,
				text: message.text || "",
				direction: "incoming",
				timestamp: message.timestamp,
			});
		});

		const savedStateEntry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom" && entry.customType === "whatsapp-state",
			);
		const isWhatsappPiOn =
			pi.getFlag("whatsapp-pi-online") === true ||
			sessionManager.getAutoConnect();
		const registered = await sessionManager.isRegistered();

		if (savedStateEntry) {
			const data = (savedStateEntry as { data?: any }).data;
			if (data.status) {
				const restoredStatus =
					data.status === "connected" && !(isWhatsappPiOn && registered) ?
						"disconnected"
					:	data.status;
				await sessionManager.setStatus(restoredStatus);
			}
			if (Array.isArray(data.allowList)) {
				for (const n of data.allowList) {
					const num = typeof n === "string" ? n : n.number;
					const name = typeof n === "string" ? undefined : n.name;
					if (SessionManager.isGroupJid(num)) {
						await sessionManager.addAllowedGroup(num, name);
					} else {
						await sessionManager.addNumber(num, name);
					}
				}
			}
			if (Array.isArray(data.allowedGroups)) {
				for (const g of data.allowedGroups) {
					const groupJid = typeof g === "string" ? g : g.number;
					const name = typeof g === "string" ? undefined : g.name;
					await sessionManager.addAllowedGroup(groupJid, name);
				}
			}
		}

		if (isWhatsappPiOn && registered && shouldStartPolling(ctx)) {
			ctx.ui.setStatus("whatsapp", "| WhatsApp: Auto-connecting...");

			// Retry logic (max 3 attempts, 3s delay)
			let attempts = 0;
			const maxAttempts = 4; // Initial + 3 retries

			const tryConnect = async () => {
				attempts++;
				try {
					await whatsappService.start({ allowPairingOnAuthFailure: false });
				} catch {
					if (attempts < maxAttempts) {
						ctx.ui.notify(
							`WhatsApp: Connection attempt ${attempts} failed. Retrying...`,
							"warning",
						);
						setTimeout(tryConnect, 3000);
					} else {
						ctx.ui.notify(
							"WhatsApp: Auto-connect failed after multiple attempts.",
							"error",
						);
						ctx.ui.setStatus("whatsapp", "|  WhatsApp: Connection Failed");
					}
				}
			};

			await tryConnect();
		} else if (isWhatsappPiOn) {
			ctx.ui.notify(
				"WhatsApp: Auto-connect requested, but no saved WhatsApp credentials were found. Use Connect WhatsApp once to scan the QR code.",
				"warning",
			);
		} else {
			ctx.ui.notify(
				"WhatsApp: Use Connect / Reconnect WhatsApp. QR code will appear only if pairing is needed.",
				"info",
			);
		}

		ctx.ui.notify(
			"WhatsApp: Session reset via /new is now fully supported.",
			"info",
		);
	});

	// Track whether send_wa_message tool already sent a reply this turn
	let toolSentToJid: string | null = null;

	const toRecentSenderNumber = (recipientJid: string): string => {
		if (recipientJid.endsWith("@g.us")) {
			return recipientJid;
		}

		return `+${recipientJid.split("@")[0]}`;
	};

	// Handle incoming messages by injecting them as user prompts
	whatsappService.setMessageCallback(async (m) => {
		const msg = m.messages?.[0];
		if (!msg?.message) return;

		const remoteJid = msg.key.remoteJid;
		const isGroup = remoteJid?.endsWith("@g.us") || false;
		const participantJid = msg.key.participant || "";
		const participantAlt = (msg.key as { participantAlt?: string } | undefined)
			?.participantAlt;
		const sender = remoteJid?.split("@")[0] || "unknown";
		const pushName = msg.pushName || "WhatsApp User";

		// Mark as read and start typing indicator immediately
		if (remoteJid && msg.key.id) {
			whatsappService.markRead(remoteJid, msg.key.id, msg.key.fromMe);
			whatsappService.sendPresence(remoteJid, "composing");
		}

		// Reset tool-sent flag for this new incoming message
		toolSentToJid = null;

		const resolved = extractIncomingText(msg.message);
		if (resolved.kind === "system") {
			logger.log(`[WhatsApp-Pi] ${pushName} (${sender}): ${resolved.text}`);
			return;
		}

		const { text, imageBuffer, imageMimeType, savedMediaPath } =
			await incomingMediaService.process(resolved, pushName);

		// Media indicator for outgoing messages
		const mediaIndicator =
			resolved.kind === "image" ? "📷 Photo"
			: resolved.kind === "video" ? "🎥 Video"
			: resolved.kind === "audio" ? "🎤 Audio"
			: resolved.kind === "document" ? "📄 Document"
			: resolved.kind === "contact" ? "👤 Contact"
			: resolved.kind === "location" ? "📍 Location"
			: resolved.kind === "reaction" ? "❤️ Reaction"
			: "";

		// Format message header: clear direction (sent vs received)
		const operatorJid = whatsappService.getOperatorJid();
		const operatorNumber = operatorJid ? operatorJid.split("@")[0] : "";
		const isOperator = !isGroup && operatorNumber && sender === operatorNumber;

		const isFromMe = msg.key.fromMe === true;

		/** Look up a contact name from contactsService or config lists. */
		const lookupName = (jidNumber: string): string => {
			const clean = jidNumber.startsWith("+") ? jidNumber : `+${jidNumber}`;
			// Check contacts service first
			try {
				const cs = whatsappService.getContactsService();
				const contact = cs.getContact(clean);
				if (contact?.name || contact?.notify)
					return contact.name || contact.notify!;
			} catch {
				/* contacts not ready */
			}
			// Check allowList / updateList
			const all = [
				...sessionManager.getAllowList(),
				...sessionManager.getUpdateList(),
			];
			const found = all.find(
				(c) => c.number === clean || c.number === jidNumber,
			);
			if (found?.name) return found.name;
			return jidNumber; // fallback
		};

		/** Look up a group name: real WhatsApp subject first, stored alias as fallback. */
		const lookupGroupName = (groupJid: string): string => {
			const subject = whatsappService.getGroupSubject(groupJid);
			if (subject) return subject;
			const g = sessionManager
				.getAllowedGroups()
				.find((c) => c.number === groupJid);
			return g?.name || groupJid;
		};

		/** Device index of this extension's own linked-device session (when connected). */
		const selfDevice = parseJid(
			whatsappService.getSocket()?.user?.id ?? "",
		).device;
		const participantInfo = parseJid(participantJid);
		const altInfo = parseJid(participantAlt ?? "");

		/**
		 * Clear sender identity: for own messages, which device sent it (phone,
		 * linked device, or this extension); for others, their PN (resolved from
		 * LID when available) plus the device that sent it.
		 */
		const describeSender = (): string => {
			if (isFromMe) {
				if (sentByExtension) return "assistant (extension)";
				return describeSelfDevice(participantInfo.device, selfDevice);
			}
			const pn =
				altInfo.user ? `+${altInfo.user}`
				: participantInfo.isLid ? `${participantInfo.user}@lid`
				: `+${participantInfo.user || sender}`;
			return participantInfo.device === undefined ?
					pn
				:	`${pn} · device #${participantInfo.device}`;
		};

		// Outgoing echoes carry no pushName for extension-sent messages; fall back
		// to the assistant name from settings so it reads "Carl sent to ..." instead
		// of "WhatsApp User sent to ...".
		const fromMeName = msg.pushName || sessionManager.getAssistantName();
		const groupLabel =
			isGroup ? `${lookupGroupName(remoteJid ?? "")} (group)` : "";

		// True when THIS extension sent the message (echo skip + [assistant] label).
		const sentByExtension = whatsappService.wasSentByExtension(remoteJid, msg.key?.id);

		const messageHeader =
			isFromMe ?
				`${fromMeName} [${describeSender()}] sent to ${isGroup ? groupLabel : `${lookupName(sender)} (DM)`}${mediaIndicator ? ` ${mediaIndicator}` : ""}:`
			: isOperator ? `[Operator] ${pushName} (${sender}):`
			: isGroup ?
				`Message from ${pushName} (${describeSender()}) in group ${groupLabel}:`
			:	`Direct message from ${pushName} (${sender}):`;

		logger.log(`[WhatsApp-Pi] ${messageHeader} ${text}`);

		// Outgoing echoes are shown in the chat for awareness. Messages sent by
		// THIS extension (tools/cron) are display-only echoes: the assistant just
		// produced them, re-running on its own output is useless — no turn for
		// DMs or groups. Messages Ben writes from his phone to an ALLOWED group
		// remain a legitimate assistant prompt (shared account).
		if (isFromMe && !isOperator) {
			// appendEntry: displayed in the TUI immediately, never triggers a turn.
			pi.appendEntry("whatsapp-echo", { content: `${messageHeader} ${text}` });
			if (!isGroup || sentByExtension) {
				return;
			}
		}

		// Use a standard delivery for ALL messages to ensure TUI consistency
		if (imageBuffer && imageMimeType) {
			pi.sendUserMessage(
				[
					{ type: "text", text: `${messageHeader} ${text}` },
					{
						type: "image",
						data: imageBuffer.toString("base64"),
						mimeType: imageMimeType,
					},
				],
				{ deliverAs: "followUp" },
			);
		} else {
			pi.sendUserMessage(`${messageHeader} ${text}`, { deliverAs: "followUp" });
		}

		// Handle commands
		if (text.trim().toLowerCase().startsWith("/compact")) {
			logger.log(`[WhatsApp-Pi] Session compact requested by ${pushName}.`);

			if (_ctx) {
				_ctx.compact();
				whatsappService
					.sendMessage(remoteJid!, "Session compacted successfully! ✅")
					.catch(() => {});
			}
			return;
		}

		if (text.trim().toLowerCase().startsWith("/abort")) {
			logger.log(`[WhatsApp-Pi] Abort requested by ${pushName}.`);
			if (_ctx) {
				_ctx.abort();
				whatsappService.sendMessage(remoteJid!, "Aborted! ✅").catch(() => {});
			}
			return;
		}
	});

	// Register send_wa_message tool (LLM-callable)
	pi.registerTool({
		name: "send_wa_message",
		label: "Send WhatsApp Message",
		description:
			"Send a WhatsApp message to a contact or group. The 'jid' parameter is the WhatsApp JID (e.g. 5511999998888@s.whatsapp.net for contacts, or 120363012345@g.us for groups). If omitted, replies to the last conversation.",
		promptSnippet:
			"send_wa_message(jid, message) - Send a WhatsApp message. jid is required (e.g. 5511999998888@s.whatsapp.net or 120363012345@g.us). IMPORTANT: After calling this tool, do NOT generate any follow-up text or confirmation — the message is already delivered to WhatsApp. Your entire response to the user should be sent ONLY through this tool, not repeated in chat.",
		parameters: Type.Object({
			jid: Type.Optional(
				Type.String({ description: "WhatsApp JID of the recipient" }),
			),
			recipient_jid: Type.Optional(
				Type.String({ description: "Alternative name for jid" }),
			),
			message: Type.String({
				minLength: 1,
				description: "Plain-text message content to send",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Resolve JID: jid > recipient_jid > lastRemoteJid > operatorJid (QR-scanned number)
			const resolvedJid =
				params.jid ||
				params.recipient_jid ||
				whatsappService.getLastRemoteJid() ||
				whatsappService.getOperatorJid();
			if (!resolvedJid) {
				logger.log(
					`[send_wa_message] DEBUG: params.jid=${params.jid}, params.recipient_jid=${params.recipient_jid}`,
				);
				logger.log(
					`[send_wa_message] DEBUG: lastRemoteJid=${whatsappService.getLastRemoteJid()}, operatorJid=${whatsappService.getOperatorJid()}`,
				);
				logger.log(`[send_wa_message] DEBUG: resolvedJid=${resolvedJid}`);
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "No JID provided and no active conversation to reply to",
								attempts: 0,
							}),
						},
					],
				};
			}

			logger.log(
				`[send_wa_message] DEBUG: status=${whatsappService.getStatus()}`,
			);
			if (whatsappService.getStatus() !== "connected") {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: t("tool.error.notConnected"),
								attempts: 0,
							}),
						},
					],
				};
			}
			// Update list filter: if updateList is non-empty, only allow sends to listed JIDs
			const operatorJid = whatsappService.getOperatorJid();
			const resolvedOperatorJid =
				operatorJid ?
					whatsappService.resolveOutboundRecipientJid(operatorJid)
				:	null;
			const isToOperator = operatorJid && resolvedJid === resolvedOperatorJid;

			logger.log(
				`[send_wa_message] DEBUG: operatorJid=${operatorJid}, resolvedOperatorJid=${resolvedOperatorJid}, isToOperator=${isToOperator}`,
			);

			const updateList = sessionManager.getUpdateList();
			const isAllowed = await sessionManager.isAllowedUpdateTarget(resolvedJid);
			logger.log(
				`[send_wa_message] DEBUG: updateList=[${updateList.join(",")}], isAllowed=${isAllowed}`,
			);

			if (!isToOperator) {
				if (updateList.length > 0 && !isAllowed) {
					logger.log(
						`[send_wa_message] BLOCKED: ${resolvedJid} not in updateList and not operator`,
					);
					return {
						isError: true,
						details: undefined,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Recipient ${resolvedJid} is not in the update list. Only approved numbers can receive messages.`,
									attempts: 0,
								}),
							},
						],
					};
				}
			}

			const message = params.message ?? "";
			const formattedMessage = message
				.split("\n")
				.map((line: string) => `    ${line}`)
				.join("\n");

			logger.log(
				[
					t("log.outgoing.title"),
					t("log.outgoing.to", { jid: resolvedJid }),
					t("log.outgoing.message"),
					formattedMessage,
				].join("\n"),
			);

			const outboundJid =
				whatsappService.resolveOutboundRecipientJid(resolvedJid);
			// Fire-and-forget: return immediately, send in background
			toolSentToJid = outboundJid;
			recentsService
				.recordMessage({
					messageId: `pending-${Date.now()}`,
					senderNumber: toRecentSenderNumber(outboundJid),
					text: message,
					direction: "outgoing",
					timestamp: Date.now(),
				})
				.catch(() => {});

			whatsappService
				.sendMessage(outboundJid, message)
				.then((result) => {
					if (result.success) {
						logger.log(
							`[send_wa_message] SENT to ${outboundJid}, messageId=${result.messageId}`,
						);
					} else {
						logger.log(
							`[send_wa_message] FAILED to ${outboundJid}: ${result.error}`,
						);
					}
				})
				.catch((err) => {
					logger.log(`[send_wa_message] ERROR sending to ${outboundJid}:`, err);
				});

			logger.log(
				`[send_wa_message] QUEUED (fire-and-forget) to ${outboundJid}`,
			);

			return {
				isError: false,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							pending: true,
							messageId: `pending-${Date.now()}`,
						}),
					},
				],
			};
		},
	});

	// Register send_reaction tool (LLM-callable)
	pi.registerTool({
		name: "send_reaction",
		label: t("tool.sendReaction.label"),
		description: t("tool.sendReaction.description"),
		promptSnippet:
			"send_reaction(jid, messageId, emoji) - React to a WhatsApp message with an emoji. The 'jid' is the chat JID (e.g. 5511999998888@s.whatsapp.net), 'messageId' is the ID of the message to react to, and 'emoji' is the emoji to react with (e.g., 👍, ❤️, 😂).",
		parameters: Type.Object({
			jid: Type.String({
				description:
					"WhatsApp JID of the chat (e.g. 5511999998888@s.whatsapp.net or 120363012345@g.us)",
			}),
			messageId: Type.String({ description: "ID of the message to react to" }),
			emoji: Type.String({
				description:
					"Emoji to react with (e.g., 👍, ❤️, 😂). Use empty string to remove reaction.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Get socket from WhatsApp service
			const socket = whatsappService.getSocket();
			if (!socket) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: t("service.whatsapp.notConnected"),
							}),
						},
					],
				};
			}

			// Create sender with the socket
			const sender = new ReactionSender(socket as any);
			const result = await sender.sendReaction({
				jid: params.jid ?? "",
				messageId: params.messageId ?? "",
				emoji: params.emoji ?? "",
			});

			return {
				isError: !result.success,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: result.success,
							messageId: result.messageId,
							error: result.error,
						}),
					},
				],
			};
		},
	});

	// Register send_wa_media tool (LLM-callable)
	pi.registerTool({
		name: "send_wa_media",
		label: "Send WhatsApp Media",
		description:
			"Send an image, video, or document to a WhatsApp contact or group. The media must be a local file path.",
		promptSnippet:
			"send_wa_media(jid, mediaPath, type, caption?) - Send media. type is 'image', 'video', or 'document'. mediaPath is the local file path.",
		parameters: Type.Object({
			jid: Type.String({
				description:
					"WhatsApp JID (e.g. 5511999998888@s.whatsapp.net or 120363012345@g.us)",
			}),
			mediaPath: Type.String({
				description: "Local file path to the media",
			}),
			type: Type.Union(
				[
					Type.Literal("image"),
					Type.Literal("video"),
					Type.Literal("document"),
				],
				{
					description: "Media type",
				},
			),
			caption: Type.Optional(
				Type.String({ description: "Optional caption for the media" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await whatsappService.sendMediaMessage(
				params.jid,
				params.mediaPath,
				params.type,
				params.caption,
			);

			return {
				isError: !result.success,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: result.success,
							messageId: result.messageId,
							error: result.error,
						}),
					},
				],
			};
		},
	});

	// Register add_wa_group_participant tool (LLM-callable)
	pi.registerTool({
		name: "add_wa_group_participant",
		label: "Add Group Participant",
		description: "Add one or more participants to a WhatsApp group.",
		promptSnippet:
			"add_wa_group_participant(groupJid, participantJids) - Add participants to a group. participantJids is an array of phone numbers or JIDs.",
		parameters: Type.Object({
			groupJid: Type.String({
				description: "Group JID (e.g. 120363012345@g.us)",
			}),
			participantJids: Type.Array(
				Type.String({ description: "Phone number or JID of participant" }),
				{ description: "List of participants to add" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await whatsappService.addGroupParticipants(
				params.groupJid,
				params.participantJids,
			);

			return {
				isError: !result.success,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result),
					},
				],
			};
		},
	});

	// Register remove_wa_group_participant tool (LLM-callable)
	pi.registerTool({
		name: "remove_wa_group_participant",
		label: "Remove Group Participant",
		description: "Remove one or more participants from a WhatsApp group.",
		promptSnippet:
			"remove_wa_group_participant(groupJid, participantJids) - Remove participants from a group.",
		parameters: Type.Object({
			groupJid: Type.String({
				description: "Group JID (e.g. 120363012345@g.us)",
			}),
			participantJids: Type.Array(
				Type.String({ description: "Phone number or JID of participant" }),
				{ description: "List of participants to remove" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await whatsappService.removeGroupParticipants(
				params.groupJid,
				params.participantJids,
			);

			return {
				isError: !result.success,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result),
					},
				],
			};
		},
	});

	// Register list_wa_conversations tool (LLM-callable, read-only)
	pi.registerTool({
		name: "list_wa_conversations",
		label: t("tool.listConversations.label"),
		description: t("tool.listConversations.description"),
		promptSnippet:
			"list_wa_conversations({onlyIncoming?, onlyAllowed?, limit?}) - List recent WhatsApp conversations from the local recents store. Read-only; safe to call any time.",
		parameters: Type.Object({
			onlyIncoming: Type.Optional(
				Type.Boolean({
					description:
						"Only return conversations whose last message is incoming (waiting for a reply).",
				}),
			),
			onlyAllowed: Type.Optional(
				Type.Boolean({
					description:
						"Only return conversations from senders/groups currently in the allow list.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description:
						"Maximum number of conversations to return (default 20).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const conversations = await recentsService.getRecentConversations();
				let filtered = conversations;
				if (params.onlyIncoming) {
					filtered = filtered.filter(
						(c) => c.lastMessageDirection === "incoming",
					);
				}
				if (params.onlyAllowed) {
					filtered = filtered.filter((c) => c.isAllowed);
				}
				const limit = typeof params.limit === "number" ? params.limit : 20;
				filtered = filtered.slice(0, limit);
				return {
					isError: false,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								count: filtered.length,
								conversations: filtered,
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	});

	// Register get_wa_conversation_history tool (LLM-callable, read-only)
	pi.registerTool({
		name: "get_wa_conversation_history",
		label: t("tool.getHistory.label"),
		description: t("tool.getHistory.description"),
		promptSnippet:
			"get_wa_conversation_history({senderNumber, limit?}) - Get the most recent messages with a sender. `senderNumber` accepts +E164 (e.g. +14155551212), raw digits, or a JID (e.g. 14155551212@s.whatsapp.net, 120363012345@g.us). Read-only.",
		parameters: Type.Object({
			senderNumber: Type.String({
				description:
					"Phone number (+E164 or raw digits) or WhatsApp JID of the conversation.",
			}),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Maximum number of messages to return (default 20).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!params.senderNumber || !params.senderNumber.trim()) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: t("tool.error.missingSender"),
							}),
						},
					],
				};
			}
			try {
				const messages = await recentsService.getConversationHistory(
					params.senderNumber,
				);
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const sliced = messages.slice(-limit);
				return {
					isError: false,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								count: sliced.length,
								messages: sliced,
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	});

	// Register check_wa_new_messages tool (LLM-callable, read-only)
	pi.registerTool({
		name: "check_wa_new_messages",
		label: t("tool.checkNew.label"),
		description: t("tool.checkNew.description"),
		promptSnippet:
			"check_wa_new_messages({sinceTimestamp?}) - List conversations whose most recent message is incoming (i.e. waiting for a reply). Optional `sinceTimestamp` (ms epoch) filters to messages newer than that. Read-only.",
		parameters: Type.Object({
			sinceTimestamp: Type.Optional(
				Type.Integer({
					minimum: 0,
					description:
						"Only include conversations whose last incoming message timestamp is strictly greater than this (ms since epoch).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const conversations = await recentsService.getRecentConversations();
				const since =
					typeof params.sinceTimestamp === "number" ? params.sinceTimestamp : 0;
				const pending = conversations.filter(
					(c) =>
						c.lastMessageDirection === "incoming" && c.lastMessageTime > since,
				);
				return {
					isError: false,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								count: pending.length,
								conversations: pending,
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	});

	// Suppress automatic message_end reply when tool already sent
	// This is checked by the message_end handler below

	// Register commands
	pi.registerCommand("whatsapp", {
		description: t("command.whatsapp.description"),
		handler: async (args, ctx) => {
			_ctx = ctx;
			await menuHandler.handleCommand(ctx);

			// Persist state after changes
			pi.appendEntry("whatsapp-state", {
				status: sessionManager.getStatus(),
				allowList: sessionManager.getAllowList(),
				allowedGroups: sessionManager.getAllowedGroups(),
			});
			refreshFooterStatus();
		},
	});

	// Handle outgoing messages (Agent -> WhatsApp)
	pi.on("agent_start", async (_event, _ctx) => {
		if (sessionManager.getStatus() !== "connected") return;
		const lastJid = whatsappService.getLastRemoteJid();
		if (lastJid) {
			await whatsappService.sendPresence(
				whatsappService.resolveOutboundRecipientJid(lastJid),
				"composing",
			);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (sessionManager.getStatus() !== "connected") return;

		const { message } = event;
		// Only reply if it's the assistant and we have a valid target
		if (message.role === "assistant") {
			const lastJid = whatsappService.getLastRemoteJid();
			const text = message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const outboundJid =
				lastJid ? whatsappService.resolveOutboundRecipientJid(lastJid) : null;

			// Skip if send_wa_message tool already sent a reply to this JID
			if (toolSentToJid === outboundJid) {
				toolSentToJid = null;
				return;
			}

			// Only auto-reply if recipient is in updateList (allowed proactive target)
			const isUpdateTarget =
				outboundJid &&
				(await sessionManager.isAllowedUpdateTarget(outboundJid));

			if (!isUpdateTarget) {
				return; // Don't auto-reply to contacts not in updateList
			}

			if (outboundJid && text) {
				// Fire-and-forget: don't block conversation
				recentsService
					.recordMessage({
						messageId: `pending-${Date.now()}`,
						senderNumber: toRecentSenderNumber(outboundJid),
						text,
						direction: "outgoing",
						timestamp: Date.now(),
					})
					.catch(() => {});

				whatsappService
					.sendMessage(outboundJid, text)
					.then((result) => {
						if (result.success) {
							ctx.ui.notify(`[message_end] SENT to ${outboundJid}`, "info");
						} else {
							ctx.ui.notify(
								`[message_end] FAILED to ${outboundJid}: ${result.error}`,
								"error",
							);
						}
					})
					.catch((err) => {
						ctx.ui.notify(
							`[message_end] ERROR sending to ${outboundJid}: ${err}`,
							"error",
						);
					});
			}
		}
	});

	// =========================================================================
	// Daily tools: weather, pin-up, saying of the day
	// =========================================================================

	// --- Weather tool (wttr.in free API) ---
	pi.registerTool({
		name: "get_weather",
		label: "Get Weather",
		description:
			"Get the current weather for a location. Uses wttr.in free API. Pass a city name or location.",
		promptSnippet:
			"get_weather(location) - Get weather for a location. Example: get_weather('Vientiane')",
		parameters: Type.Object({
			location: Type.String({
				description:
					"City name or location (e.g. 'Vientiane', 'Paris', 'Bangkok')",
			}),
		}),
		async execute(_toolCallId, params) {
			try {
				const location = encodeURIComponent(params.location);
				const response = await fetch(`https://wttr.in/${location}?format=j1`);
				if (!response.ok)
					throw new Error(`wttr.in returned ${response.status}`);
				const data = await response.json();

				const current = data.current_condition?.[0];
				if (!current) throw new Error("No weather data available");

				const tempC = current.temp_C;
				const feelsLikeC = current.FeelsLikeC;
				const desc = current.weatherDesc?.[0]?.value || "Unknown";
				const humidity = current.humidity;
				const windSpeed = current.windspeedKmph;

				return {
					isError: false,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								location:
									data.nearest_area?.[0]?.areaName?.[0]?.value ||
									params.location,
								temperature: `${tempC}°C`,
								feelsLike: `${feelsLikeC}°C`,
								description: desc,
								humidity: `${humidity}%`,
								windSpeed: `${windSpeed} km/h`,
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	});

	// --- Pin-up of the day tool ---
	pi.registerTool({
		name: "get_pinup_of_the_day",
		label: "Pin-up of the Day",
		description: "Get a random pin-up/glamour photo of the day.",
		promptSnippet: "get_pinup_of_the_day() - Get a random pin-up photo",
		parameters: Type.Object({}),
		async execute(_toolCallId) {
			// Scrape pornpics.com via the local pi-chrome bridge (real Chrome profile).
			const bridge = "http://127.0.0.1:17318/command";
			const cmd = async (
				action: string,
				params: Record<string, unknown>,
				timeoutMs = 20000,
			) => {
				const res = await fetch(bridge, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action, params, timeoutMs }),
				});
				const json = (await res.json()) as {
					ok: boolean;
					result?: unknown;
					error?: string;
				};
				if (!json.ok) throw new Error(json.error || "bridge command failed");
				return json.result;
			};
			try {
				// Rotate the search query daily so the photo pool changes every day.
				const queries = [
					"skinny+petite+asian",
					"skinny+teen",
					"anal+petite+asian",
					"petite+chinese+beauty",
					"asian+beauty",
					"petite+asian+double",
					"skinny+brunette+beauty",
					"petite+deep",
					"petite+asian+facial",
					"petite+asian+full",
				];
				const dayIdx = Math.floor(Date.now() / 86400000) % queries.length;
				await cmd(
					"page.navigate",
					{ url: `https://www.pornpics.com/?q=${queries[dayIdx]}` },
					30000,
				);
				const urls = (await cmd(
					"page.evaluate",
					{
						expression:
							"Array.from(document.querySelectorAll('img'))" +
							".map(i => i.currentSrc || i.src || i.dataset.src)" +
							".filter(s => s && s.includes('cdni.pornpics.com'))",
					},
					15000,
				)) as string[];
				if (!Array.isArray(urls) || urls.length === 0)
					throw new Error("no images found on page");
				const pick = urls[Math.floor(Math.random() * urls.length)].replace(
					"/460/",
					"/1280/",
				);
				return {
					isError: false,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								imageUrl: pick,
								caption: "Pin-up of the day 📸",
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	});

	// --- Saying of the day tool ---
	pi.registerTool({
		name: "get_saying_of_the_day",
		label: "Saying of the Day",
		description: "Get a random saying, proverb, or quote of the day.",
		promptSnippet: "get_saying_of_the_day() - Get a random saying or quote",
		parameters: Type.Object({}),
		async execute(_toolCallId) {
			const sayings = [
				// English proverbs with French translations
				"Where there is a will, there is a way. (Quand on veut, on peut) 💪",
				"Actions speak louder than words. (Les actes comptent plus que les mots) 🗣️",
				"Better late than never. (Mieux vaut tard que jamais) ⏰",
				"Do not count your chickens before they hatch. (Ne compte pas tes poulets avant qu'ils soient nés) 🐣",
				"Every cloud has a silver lining. (Il n y a pas de nuage sans bord argenté) ☁️",
				"Fortune favors the bold. (La fortune favorise les audacieux) 🎯",
				"Give someone an inch and they will take a mile. (On vous donne un pouce, on vous prendra un mile) 📏",
				"Honesty is the best policy. (L honnêteté est la meilleure politique) 🤝",
				"If the shoe fits, wear it. (Si la chaussure convient, porte-la) 👞",
				"It is never too late to learn. (On n est jamais trop vieux pour apprendre) 📚",
				"Knowledge is power. (Le savoir, c est le pouvoir) 🧠",
				"Less is more. (Moins c est plus) ✨",
				"Look before you leap. (Regarde avant de sauter) 👀",
				"Money does not grow on trees. (L argent ne pousse pas sur les arbres) 🌳",
				"No pain, no gain. (Pas de douleur, pas de gain) 🏋️",
				"Practice makes perfect. (C est en forgeant qu on devient forgeron) 🔨",
				"Rome was not built in a day. (Rome ne s est pas faite en un jour) 🏛️",
				"Slow and steady wins the race. (Le petit bonhomme arrive toujours à bout) 🐢",
				"The early bird catches the worm. (Le premier arrivé profite le mieux) 🐦",
				"The grass is always greener on the other side. (L herbe est toujours plus verte ailleurs) 🌿",
				"There is no place like home. (On n est jamais mieux que chez soi) 🏠",
				"Time flies when you are having fun. (Le temps vole quand on s amuse) ⏳",
				"Two heads are better than one. (Deux cerveaux valent mieux qu un) 🧠",
				"Variety is the spice of life. (La variété est l épice de la vie) 🌶️",
				"When in Rome, do as the Romans do. (Quand à Rome, fais comme les Romains) 🏛️",
				"You cannot judge a book by its cover. (On ne juge pas un livre à sa couverture) 📖",
				"A journey of a thousand miles begins with a single step. (Un voyage de mille miles commence par un seul pas) 👣",
				"A picture is worth a thousand words. (Une image vaut mille mots) 📸",
				"All good things must come to an end. (Toutes les bonnes choses ont une fin) 🎭",
				"An apple a day keeps the doctor away. (Une pomme par jour éloigne le médecin) 🍎",
				"Beauty is in the eye of the beholder. (La beauté est dans les yeux de celui qui regarde) 👁️",
				"Better safe than sorry. (Mieux vaut prévenir que guérir) 🛡️",
				"Birds of a feather flock together. (Les oiseaux de même plume s assemblent) 🐦",
				"Break the ice. (Casser la glace) 🧊",
				"Curiosity killed the cat. (La curiosité a tué le chat) 🐱",
				"Do not put all your eggs in one basket. (Ne mets pas tous tes œufs dans le même panier) 🥚",
				"Every dog has his day. (Chacun son tour) 🐕",
				"Good things come to those who wait. (Les bonnes choses viennent à ceux qui attendent) ⏰",
				"He who laughs last laughs best. (Celui qui rit le dernier rit le mieux) 😄",
				"Ignorance is bliss. (L ignorance est un bonheur) 😌",
				"Kill two birds with one stone. (Tuer deux d un coup) 🐦🪨",
				"Let sleeping dogs lie. (Laisse les chiens qui dorment) 🐕",
				"Lightning never strikes the same place twice. (La foudre ne tombe jamais deux fois au même endroit) ⚡",
				"Make hay while the sun shines. (Tandis que brille le soleil) ☀️",
				"Necessity is the mother of invention. (La nécessité est la mère de l invention) 💡",
				"Once bitten, twice shy. (Une fois mordu, deux fois timide) 🐍",
				"People who live in glass houses should not throw stones. (Ceux qui vivent dans des maisons de verre ne doivent pas lancer de pierres) 🏠",
				"Pride comes before a fall. (La fierté précède la chute) 🦚",
				"The best things in life are free. (Les meilleures choses de la vie sont gratuites) 💎",
				"The pen is mightier than the sword. (La plume est plus forte que l épée) ✒️",
				"There is no smoke without fire. (Il n y a pas de fumée sans feu) 🔥",
				"To each their own. (Chacun son goût) 🎨",
				"Turn over a new leaf. (Tourner une nouvelle page) 📄",
				"When the going gets tough, the tough get going. (Quand ça se corse, les durs prennent le relais) 💪",
				"You cannot have your cake and eat it too. (On ne peut pas avoir le beurre et l argent du beurre) 🧈",
				"A watched pot never boils. (Une casserole qu on regarde ne bout jamais) 🍲",
				"All that glitters is not gold. (Tout ce qui brille n est pas or) ✨",
				"Beggars cannot be choosers. (Les mendiants n ont pas le choix) 🤲",
				"Do not bite the hand that feeds you. (Ne mords pas la main qui te nourrit) 🤲",
				"Every rose has its thorn. (Chaque rose a son épine) 🌹",
				"Faint heart never won fair lady. (Un cœur timide ne gagne jamais belle dame) 💝",
				"God helps those who help themselves. (Dieu aide ceux qui s aident) 🙏",
				"If you cannot beat them, join them. (Si tu ne peux pas les battre, rejoins-les) 🤝",
				"Keep your friends close and your enemies closer. (Garde tes amis proches et tes ennemis plus proches encore) 👥",
				"Laughter is the best medicine. (Le rire est le meilleur médicament) 😂",
				"Let bygones be bygones. (Laisse le passé derrière toi) 🌅",
				"Life is what happens when you are busy making plans. (La vie, c est ce qui arrive quand tu es occupé à faire des plans) 📝",
				"Make your own luck. (Crée ta propre chance) 🍀",
				"Never put off till tomorrow what you can do today. (Ne remets jamais à demain ce que tu peux faire aujourd hui) ⏰",
				"Old habits die hard. (Les vieilles habitudes meurent difficilement) 🔄",
				"Patience is a virtue. (La patience est une vertu) 🧘",
				"Speak softly and carry a big stick. (Parle doucement et porte un gros bâton) 🥖",
				"The world is your oyster. (Le monde est ton huître) 🦪",
				"Those who do not learn from history are doomed to repeat it. (Ceux qui n apprennent pas de l histoire sont condamnés à la répéter) 📜",
				"Time and tide wait for no man. (Le temps et les marées n attendent personne) 🌊",
				"Unity is strength. (L union fait la force) 💪",
				"Where there is smoke, there is fire. (Où il y a de la fumée, il y a du feu) 🔥",
				"You are what you eat. (Tu es ce que tu manges) 🥗",
				"A bird in the hand is worth two in the bush. (Un oiseau dans la main vaut deux dans le buisson) 🐦",
				"A chain is only as strong as its weakest link. (Une chaîne n est forte que par son maillon le plus faible) ⛓️",
				"A word to the wise is sufficient. (Un mot suffit aux avisés) 💬",
				"Beauty is only skin deep. (La beauté n est que superficielle) 🎭",
				"Better to light a candle than curse the darkness. (Mieux vaut allumer une bougie que maudire l obscurité) 🕯️",
				"Do not cry over spilt milk. (Ne pleure pas sur du lait renversé) 🥛",
				"Fortune favors the prepared mind. (La fortune favorise l esprit préparé) 🧠",
				"He who asks is a fool for five minutes. (Celui qui demande est un idiot cinq minutes) 🤔",
				"In the middle of difficulty lies opportunity. (Au milieu de la difficulté se trouve l opportunité) 🌟",
				"It takes two to tango. (Il en faut deux pour danser le tango) 💃",
				"Knowledge speaks, but wisdom listens. (Le savoir parle, mais la sagesse écoute) 👂",
				"Life is short, art is long. (La vie est courte, l art est éternel) 🎨",
				"Make the best of a bad situation. (Fais le meilleur d une mauvaise situation) 🔄",
				"One man s trash is another man s treasure. (La poubelle d un homme est le trésor d un autre) 🗑️",
				"Patience is the companion of wisdom. (La patience est la compagne de la sagesse) 🧘",
				"The bigger they are, the harder they fall. (Plus ils sont gros, plus ils tombent fort) 🏋️",
				"Time is money. (Le temps, c est de l argent) 💰",
				"Too many cooks spoil the broth. (Trop de cuisiniers gâchent le bouillon) 🍲",
				"Truth is stranger than fiction. (La vérité est plus étrange que la fiction) 📚",
				"What goes around comes around. (Ce qui tourne revient) 🔄",
				"You cannot make an omelette without breaking eggs. (On ne fait pas d omelette sans casser des œufs) 🥚",
				"A friend in need is a friend indeed. (Un ami dans le besoin est un ami vraiment) 🤝",
				"A little knowledge is a dangerous thing. (Un peu de savoir est une chose dangereuse.) ⚠️",
				"Better be the head of a dog than the tail of a lion. (Mieux vaut être la tête d un chien que la queue d un lion.) 🦁",
				"Come what may. (Vienne que pourra) 🌊",
				"Deeds, not words. (Les actes, pas les mots) 🤲",
				"Do not burn your bridges. (Ne brûle pas tes ponts.) 🌉",
				"Do not put the cart before the horse. (Ne mets pas la charrue avant les bœufs.) 🐂",
				"Do not throw the baby out with the bathwater. (Ne jette pas le bébé avec l eau du bain.) 👶",
				"Do unto others as you would have them do unto you. (Fais aux autres ce que tu voudrais qu ils te fassent) 🤝",
				"Every little bit helps. (Chaque petit peu aide) 💰",
				"Every man has his price. (Chaque homme a son prix) 💎",
				"Experience is the best teacher. (L expérience est le meilleur professeur) 📚",
				"Fall seven times, stand up eight. (Tombe sept fois, debout huit.) 🥋",
				"Fortune favors the brave. (La fortune favorise les braves.) 🦁",
				"Good advice is never lost. (Un bon conseil n est jamais perdu) 💡",
				"Great minds think alike. (Les grands esprits se rencontrent) 🧠",
				"Gratitude is the memory of the heart. (La gratitude est la mémoire du cœur) ❤️",
				"He who hesitates is lost. (Celui qui hésite est perdu.) ⏱️",
				"Hope for the best, prepare for the worst. (Espère le meilleur, prépare le pire) 🛡️",
				"If at first you do not succeed, try again. (Si au premier coup tu ne réussis pas, essaie encore) 🎯",
				"Keep your eye on the prize. (Garde l œil sur la récompense) 🏆",
				"Live and let live. (Vis et laisse vivre) 🕊️",
				"Many hands make light work. (Beaucoup de mains allègent le travail) 🤲",
				"Measure twice, cut once. (Mesure deux fois, coupe une fois) 📏",
				"No man is an island. (Nul homme est une île) 🏝️",
				"Nothing comes to the man who waits. (Rien ne vient à l homme qui attend) 🧍",
				"One good turn deserves another. (Un bon service en mérite un autre) 🤝",
				"Opportunity knocks but once. (L opportunité frappe une seule fois) 🚪",
				"Out of sight, out of mind. (Loin des yeux, loin du cœur) 👁️",
				"Patience is bitter, but its fruit is sweet. (La patience est amère, mais son fruit est doux) 🍯",
				"Prevention is better than cure. (Prévenir vaut mieux que guérir) 🛡️",
				"Sharpen your axe. (Aiguiser ta hache) 🪓",
				"Show me your friends and I will show you your future. (Montre-moi tes amis et je te montrerai ton futur) 👥",
				"Smooth seas do not make skillful sailors. (Des mers calmes ne font pas des marins habiles) ⛵",
				"Still waters run deep. (Les eaux calmes coulent profond) 🌊",
				"Strike while the iron is hot. (Frappe pendant que le fer est chaud) 🔥",
				"The best things in life are not things. (Les meilleures choses de la vie ne sont pas des objets) 💝",
				"The die is cast. (Les dés sont jetés) 🎲",
				"The end justifies the means. (La fin justifie les moyens) 🎯",
				"The eye is the window to the soul. (L œil est la fenêtre de l âme) 👁️",
				"The grass is greener where you water it. (L herbe est plus verte où tu arroses) 💧",
				"The more the merrier. (Plus il y en a, plus c est joyeux) 🎉",
				"The road to hell is paved with good intentions. (La route de l enfer est pavée de bonnes intentions) 🛤️",
				"The sun shines on us all. (Le soleil brille sur nous tous) ☀️",
				"The world is a book. (Le monde est un livre) 📚",
				"There are two sides to every story. (Il y a deux côtés à chaque histoire) 📖",
				"There is no royal road to learning. (Il n y a pas de route royale vers l apprentissage) 🛤️",
				"There is no accounting for taste. (On ne peut pas rendre compte du goût) 🎨",
				"This too shall pass. (Cela aussi passera) ⏳",
				"Through perseverance many who are weak become strong. (Par la persévérance, beaucoup de faibles deviennent forts) 💪",
				"Try not to become a man of success. (Essaie de ne pas devenir un homme de succès) 🌟",
				"Turn the other cheek. (Tourne l autre joue) 🤲",
				"Use it or lose it. (Utilise-le ou perds-le) 🏋️",
				"Virtue is its own reward. (La vertu est sa propre récompense) 🏆",
				"Walk before you run. (Marche avant de courir) 🏃",
				"We are what we repeatedly do. (Nous sommes ce que nous faisons répétitivement) 🔄",
				"When one door closes, another opens. (Quand une porte se ferme, une autre s ouvre) 🚪",
				"While there is life, there is hope. (Tant qu il y a la vie, il y a l espoir) 🌱",
				"Who sows the wind reaps the whirlwind. (Qui sème le vent récolte l ouragan) 🌪️",
				"Win some, lose some. (Gagne quelques-unes, perde quelques-unes) 🎲",
				"With age comes wisdom. (Avec l âge vient la sagesse) 👴",
				"You can lead a horse to water but you cannot make him drink. (Tu peux amener un cheval à l eau mais tu ne peux pas le faire boire) 🐴",
				"You cannot judge a book by its cover. (On ne peut pas juger un livre par sa couverture) 📖",
				"You cannot have your cake and eat it too. (On ne peut pas avoir son beurre et l argent du beurre) 🧈",
				"You cannot teach an old dog new tricks. (On n apprend pas de nouveaux tours à un vieux chien) 🐕",
				"You make your own luck. (Tu fais ta propre chance) 🍀",
				"You are never too old to learn. (On n est jamais trop vieux pour apprendre) 📚",
				"Your attitude, not your aptitude, determines your altitude. (Ton attitude, pas ton aptitude, détermine ton altitude) 📈",
				"Yesterday is history, tomorrow is a mystery, today is a gift. (Hier est l histoire, demain est un mystère, aujourd hui est un cadeau) 🎁",
				"You will catch more flies with honey than with vinegar. (Tu attraperas plus de mouches avec du miel qu avec du vinaigre) 🍯",
				"A new language is a new life. (Une nouvelle langue est une nouvelle vie) 🌍",
				"A thing of beauty is a joy forever. (Une chose de beauté est une joie éternelle) 🌹",
				"A wise man is never satisfied. (Un homme sage n est jamais satisfait) 🧠",
				"All that glitters is not gold. (Tout ce qui brille n est pas or) ✨",
				"All the world is a stage. (Tout le monde est une scène) 🎭",
				"All things are difficult before they are easy. (Toutes choses sont difficiles avant qu elles ne soient faciles) 📈",
				"Always do right. This will gratify some people and astonish the rest. (Fais toujours le bien. Cela satisfera certaines personnes et étonnera le reste) 🌟",
				"Be curious, not judgmental. (Sois curieux, pas jugeur) 🔍",
				"Be the change you wish to see in the world. (Sois le changement que tu veux voir dans le monde) 🌍",
				"Be yourself; everyone else is already taken. (Sois toi-même ; tous les autres sont déjà pris) 🎭",
				"Before you judge a man, walk a mile in his shoes. (Avant de juger un homme, marche un mile dans ses chaussures) 👞",
				"Be who you are and say what you feel. (Sois qui tu es et dis ce que tu ressens) 💬",
				"Better an empty purse than an empty head. (Mieux vaut un portefeuille vide qu une tête vide) 💰",
				"Better to have loved and lost than never to have loved at all. (Mieux vaut avoir aimé et perdu que de ne jamais avoir aimé) ❤️",
				"Better to light one candle than curse the darkness. (Mieux vaut allumer une bougie que maudire l obscurité) 🕯️",
				"Better to travel well than to arrive. (Mieux vaut voyager bien que d arriver) 🧳",
				"Beware of Greeks bearing gifts. (Garde-toi des Grecs portant des cadeaux) 🎁",
				"Carpe diem. (Saisis le jour) 📅",
				"Change is the end result of all true learning. (Le changement est le résultat final de tout vrai apprentissage) 🔄",
				"Change your thoughts and you change your world. (Change tes pensées et tu changes ton monde) 🌍",
				"Cherish your visions and your dreams. (Chéris tes visions et tes rêves) 💫",
				"Choose a job you love. (Choisis un travail que tu aimes) ❤️",
				"Count your blessings. (Compte tes bénédictions) 🙏",
				"Creativity is intelligence having fun. (La créativité est l intelligence qui s amuse) 🎨",
				"Defeat is a state of mind. (La défaite est un état d esprit) 🧠",
				"Do what you can, with what you have, where you are. (Fais ce que tu peux, avec ce que tu as, où tu es.) 📍",
				"Dost thou love life? Then do not squander time. (Aimes-tu la vie ? Alors ne gaspille pas le temps) ⏳",
				"Dream big and dare to fail. (Rêve grand et ose échouer) 💫",
				"Drop by drop is the water pot filled. (Goutte par goutte, le pot d eau se remplit) 💧",
				"Education is the most powerful weapon. (L éducation est l arme la plus puissante) 📚",
				"Efficiency is doing things right. (L efficacité, c est faire les choses correctement) ✅",
				"Enjoy the little things. (Apprécie les petites choses) 🌸",
				"Err on the side of love. (Errer du côté de l amour) ❤️",
				"Eyes are useless when the mind is blind. (Les yeux sont inutiles quand l esprit est aveugle) 👁️",
				"Face the truth. (Fais face à la vérité) 🔍",
				"From error to error one discovers the entire truth. (D erreur en erreur on découvre toute la vérité) 🔍",
				"From small acorns come large oaks. (Des petits glands viennent de grands chênes) 🌳",
				"Gain what you will, wisdom is the only wealth. (Gagne ce que tu veux, la sagesse est le seul trésor) 💎",
				"Genius is one percent inspiration. (Le génie c est un pour cent d inspiration) ✨",
				"Get busy living or get busy dying. (Occupe-toi de vivre ou occupe-toi de mourir) 🌱",
				"Good actions give strength to ourselves. (Les bonnes actions nous donnent de la force) 💪",
				"Gratitude can transform common days into thanksgiving. (La gratitude peut transformer les jours ordinaires en action de grâce) 🙏",
				"Gratitude is the memory of the heart. (La gratitude est la mémoire du cœur) ❤️",
				"Great things are done by a series of small things brought together. (Les grandes choses sont faites par une série de petites choses rassemblées) 🧩",
				"Growth begins at the end of your comfort zone. (La croissance commence à la fin de ta zone de confort) 🌱",
				"Happiness is a direction, not a place. (Le bonheur est une direction, pas un endroit) 🧭",
				"Happiness is not something ready made. (Le bonheur n est pas quelque chose de prêt à l emploi) 😊",
				"Happiness is not something you postpone for the future. (Le bonheur n est pas quelque chose que tu remets au futur) ⏰",
				"Happiness is not something you wait for. (Le bonheur n est pas quelque chose que tu attends) 😊",
				"Happiness is the way. (Le bonheur est le chemin) 🛤️",
				"He who learns teaches. (Celui qui apprend enseigne) 📚",
				"He who lives by the bell, rings for dinner. (Celui qui vit avec la cloche, sonne pour le dîner) 🔔",
				"He who talks more is sooner exhausted. (Celui qui parle plus est plus tôt épuisé) 🗣️",
				"He who wishes to secure the good of others has already secured his own. (Celui qui veut assurer le bien des autres a déjà assuré le sien) 🤝",
				"He who knows does not explain. (Celui qui sait n explique pas) 🤫",
				"He who knows himself is enlightened. (Celui qui se connaît est éclairé) ✨",
				"He who knows that enough is enough will always have enough. (Celui qui sait que suffisamment est suffisant aura toujours assez) 💰",
				"He who lives without folly is greater than the great. (Celui qui vit sans folie est plus grand que les grands) 🧠",
				"He who speaks the truth will always be right. (Celui qui dit la vérité aura toujours raison) ✅",
				"Heaven is itself, right here. (Le paradis est lui-même, juste ici) 🌅",
				"Heaven will not do us good unless we do it ourselves. (Le ciel ne nous fera pas de bien à moins que nous ne le fassions nous-mêmes) 💪",
				"Home is where you start from. (La maison est où tu commences) 🏠",
				"Hope for the best, prepare for the worst. (Espère le meilleur, prépare le pire) 🛡️",
			];

			const today = new Date();
			const dayOfYear = Math.floor(
				(today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) /
					(1000 * 60 * 60 * 24),
			);
			// Hash-based rotation for maximum daily variety
			const hash = dayOfYear * 31 + 7;
			const index = hash % sayings.length;
			const saying = sayings[index];

			return {
				isError: false,
				details: undefined,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							saying: saying,
							caption: "Dicton du jour 💬",
						}),
					},
				],
			};
		},
	});

	// =========================================================================
	// End of daily tools
	// =========================================================================

	pi.on("session_shutdown", async () => {
		logger.log(
			"[WhatsApp-Pi] Session shutdown detected. Stopping WhatsApp service...",
		);
		await whatsappService.stop();
	});
}
