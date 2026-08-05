import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
				senderName: message.pushName,
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
		const participant =
			isGroup ?
				msg.key.participant?.split("@")[0] || "unknown"
			:	remoteJid?.split("@")[0] || "unknown";
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

		const { text, imageBuffer, imageMimeType } =
			await incomingMediaService.process(resolved, pushName);

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
				if (contact?.name || contact?.notify) return contact.name || contact.notify!;
			} catch { /* contacts not ready */ }
			// Check allowList / updateList
			const all = [...sessionManager.getAllowList(), ...sessionManager.getUpdateList()];
			const found = all.find((c) => c.number === clean || c.number === jidNumber);
			if (found?.name) return found.name;
			return jidNumber; // fallback
		};

		const messageHeader =
			isFromMe ? `${pushName} sent to ${lookupName(sender)}:`
			: isOperator ? `[Operator] ${pushName} (${sender}):`
			: isGroup ?
				`Message from ${pushName} (${participant}) in group ${remoteJid}:`
			:	`Message from ${pushName} (${sender}):`;

		logger.log(`[WhatsApp-Pi] ${messageHeader} ${text}`);

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
				whatsappService.sendMessage(remoteJid!, "Session compacted successfully! ✅").catch(() => {});
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
				recentsService.recordMessage({
					messageId: `pending-${Date.now()}`,
					senderNumber: toRecentSenderNumber(outboundJid),
					text,
					direction: "outgoing",
					timestamp: Date.now(),
				}).catch(() => {});

				whatsappService.sendMessage(outboundJid, text).then((result) => {
					if (result.success) {
						ctx.ui.notify(`[message_end] SENT to ${outboundJid}`, "info");
					} else {
						ctx.ui.notify(`[message_end] FAILED to ${outboundJid}: ${result.error}`, "error");
					}
				}).catch((err) => {
					ctx.ui.notify(`[message_end] ERROR sending to ${outboundJid}: ${err}`, "error");
				});
			}
		}
	});

	pi.on("session_shutdown", async () => {
		logger.log(
			"[WhatsApp-Pi] Session shutdown detected. Stopping WhatsApp service...",
		);
		await whatsappService.stop();
	});
}
