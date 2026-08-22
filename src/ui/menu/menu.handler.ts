/**
 * WhatsApp-Pi Menu Handler — Facade
 * Thin dispatcher delegating to domain-specific modules.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.js";
import { RecentsService } from "../services/recents.service.js";
import { SessionManager, type Contact } from "../services/session.manager.js";
import { WhatsAppService } from "../services/whatsapp.service.js";

import { manageContactsList } from "./contacts.menu.js";
import {
	manageContactDetail,
	manageRecents
} from "./recents.menu.js";
import { manageUpdateList } from "./update-targets.menu.js";

import type { MenuEnv } from "./menu-context.js";
import { formatContactOption, formatGroupOption, formatHistoryOption } from "./shared.helpers.js";

import { resetI18n } from "../i18n.js";

export class MenuHandler {
	private whatsappService: WhatsAppService;
	private sessionManager: SessionManager;
	private recentsService: RecentsService;
	private printedAllowedContacts: string[] = [];
	private printedAllowedGroups: string[] = [];

	constructor(
		whatsappService: WhatsAppService,
		sessionManager: SessionManager,
		recentsService: RecentsService,
	) {
		this.whatsappService = whatsappService;
		this.sessionManager = sessionManager;
		this.recentsService = recentsService;
	}

	async handleCommand(ctx: ExtensionCommandContext) {
		resetI18n();
		const status = this.whatsappService.getEffectiveStatus();
		const registered = await this.sessionManager.isRegistered();
		const title = t("menu.whatsapp.title", { status });

		const recentsLabel = t("menu.root.recents");
		const contactsListLabel = t("menu.root.contactsList");
		const allowedContactsLabel = t("menu.root.allowedNumbers");
		const allowedGroupsLabel = t("menu.root.allowedGroups");
		const updateTargetsLabel = t("menu.root.updateTargets");
		const disconnectWhatsAppLabel = t("menu.root.disconnectWhatsApp");
		const connectWhatsAppLabel = t("menu.root.connectWhatsApp");
		const logoffDeleteSessionLabel = t("menu.root.logoffDeleteSession");
		const settingsLabel = t("menu.root.settings");

		const options: string[] = [];

		if (status === "connected") {
			options.push(recentsLabel);
			options.push(contactsListLabel);
			options.push(allowedContactsLabel);
			options.push(allowedGroupsLabel);
			options.push(updateTargetsLabel);
			options.push(disconnectWhatsAppLabel);
			options.push(settingsLabel);
		} else {
			options.push(connectWhatsAppLabel);
			options.push(settingsLabel);
		}

		const choice = await ctx.ui.select(title, options);

		if (!choice) {
			return;
		}

		const env = this.buildEnv(ctx);

		if (choice === recentsLabel) {
			await manageRecents(env, ctx);
			return;
		}

		if (choice === contactsListLabel) {
			await manageContactsList(env, ctx);
			return;
		}

		if (choice === allowedContactsLabel) {
			await this.manageAllowList(ctx);
			return;
		}

		if (choice === allowedGroupsLabel) {
			await this.manageAllowedGroups(ctx);
			return;
		}

		if (choice === updateTargetsLabel) {
			await this.manageUpdateList(ctx);
			return;
		}

		if (choice === settingsLabel) {
			await this.manageSettings(ctx);
			return;
		}

		if (choice === connectWhatsAppLabel) {
			await this.whatsappService.start();
			ctx.ui.notify(t("menu.root.reconnectStarted"), "info");
			return;
		}

		if (choice === disconnectWhatsAppLabel) {
			if (this.whatsappService.getEffectiveStatus() !== "connected") {
				ctx.ui.notify(t("menu.root.alreadyDisconnected"), "info");
				return;
			}
			await this.whatsappService.stop();
			ctx.ui.notify(t("menu.root.disconnectStarted"), "info");
			return;
		}

		if (choice === logoffDeleteSessionLabel) {
			const confirmLogoff = await ctx.ui.confirm(
				t("menu.root.logoffTitle"),
				t("menu.root.logoffConfirmMessage"),
			);
			if (confirmLogoff) {
				await this.whatsappService.logout();
				ctx.ui.notify(t("menu.root.loggedOffAndDeleted"), "info");
			}
			return;
		}
	}

	// --- Delegation methods (thin wrappers) ---

	async manageAllowList(ctx: ExtensionCommandContext) {
		const env = this.buildEnv(ctx);
		const { manageAllowList } = await import("./allow-list.menu.js");
		await manageAllowList(env, ctx);
	}

	async manageAllowedGroups(ctx: ExtensionCommandContext) {
		const env = this.buildEnv(ctx);
		const { manageAllowedGroups } = await import("./allow-list.menu.js");
		await manageAllowedGroups(env, ctx);
	}

	async manageUpdateList(ctx: ExtensionCommandContext) {
		const env = this.buildEnv(ctx);
		const { manageUpdateList } = await import("./update-targets.menu.js");
		await manageUpdateList(env, ctx);
	}

	async manageSettings(ctx: ExtensionCommandContext) {
		const env = this.buildEnv(ctx);
		const { manageSettings } = await import("./settings.menu.js");
		await manageSettings(env, ctx);
	}

	// --- Private helpers ---

	private buildEnv(ctx: ExtensionCommandContext): MenuEnv {
		return {
			sessionManager: this.sessionManager,
			whatsappService: this.whatsappService,
			recentsService: this.recentsService,
			ctx,
			printedAllowedContacts: this.printedAllowedContacts,
			printedAllowedGroups: this.printedAllowedGroups,
			formatContactOption: (c: Contact) => formatContactOption(c),
			formatGroupOption: (c: Contact) => formatGroupOption(c),
			formatHistoryOption: (ts: number, dir: string, txt: string) => formatHistoryOption(ts, dir, txt),
			sendPromptedMenuMessage: this.sendPromptedMenuMessage.bind(this),
			openHistory: this.openHistory.bind(this),
			openRootMenu: () => this.handleCommand(ctx),
			ctx,
		};
	}

	async sendPromptedMenuMessage(ctx: ExtensionCommandContext, options: {
		displayName: string;
		senderNumber: string;
		senderName?: string;
		appendPiSuffix: boolean;
	}) {
		const { displayName, senderNumber, senderName, appendPiSuffix } = options;
		const inputText = await ctx.ui.input(t("menu.sendMessage.prompt", { displayName }));
		if (!inputText || !inputText.trim()) {
			ctx.ui.notify(t("menu.sendMessage.empty"), "info");
			return;
		}
		const messageText = appendPiSuffix ? `${inputText.trim()} π` : inputText.trim();
		const signature = this.sessionManager.getAgentSignature();
		const branded = signature ? `${messageText} ${signature}` : messageText;

		const outboundJid = this.whatsappService.resolveOutboundRecipientJid(senderNumber);
		const result = await this.whatsappService.sendMessage(outboundJid, branded);

		if (result.success) {
			await this.recentsService.recordMessage({
				messageId: result.messageId ?? `${Date.now()}`,
				senderNumber,
				senderName,
				text: messageText,
				direction: "outgoing",
				timestamp: Date.now()
			});
			ctx.ui.notify(t("menu.sendMessage.sent", { displayName }), "info");
		} else {
			ctx.ui.notify(t("menu.sendMessage.failed", { error: result.error }), "error");
		}
	}

	async openHistory(senderNumber: string, senderName?: string) {
		const displayName = senderName || senderNumber;
		const history = await this.recentsService.getConversationHistory(senderNumber);

		if (history.length === 0) {
			this.ctx?.ui.notify(t("menu.recents.history.empty"), "info");
			return;
		}

		const sortedHistory = this.sortHistoryByMostRecent(history);
		await this.showConversationHistoryForContact(
			this.ctx,
			senderNumber,
			displayName,
			senderName
		);
	}

	private sortHistoryByMostRecent(
		history: import("../models/whatsapp.types.js").RecentConversationMessage[],
	) {
		return history.slice().sort((a, b) => b.timestamp - a.timestamp);
	}

	private async showConversationHistoryForContact(
		ctx: ExtensionCommandContext,
		senderNumber: string,
		displayName: string,
		senderName?: string,
	) {
		const history = await this.recentsService.getConversationHistory(senderNumber);

		if (history.length === 0) {
			ctx.ui.notify(t("menu.recents.history.empty"), "info");
			return;
		}

		const sortedHistory = this.sortHistoryByMostRecent(history);
		const pageSize = 10;
		let page = 0;
		const backLabel = t("menu.root.back");
		const nextLabel = "Next";
		const previousLabel = "Previous";

		while (true) {
			const start = page * pageSize;
			const pageHistory = sortedHistory.slice(start, start + pageSize);
			const historyOptions = this.buildHistoryOptions(pageHistory);

			const title = t("menu.recents.history.title", { displayName });
			const options = [
				...historyOptions.map((option) => option.label),
				...(page > 0 ? [previousLabel] : []),
				...(start + pageSize < sortedHistory.length ? [nextLabel] : []),
				backLabel,
			];

			const choice = await ctx.ui.select(title, options);

			if (!choice || choice === backLabel) {
				return;
			}

			if (choice === previousLabel && page > 0) {
				page--;
				continue;
			}
			if (choice === nextLabel && start + pageSize < sortedHistory.length) {
				page++;
				continue;
			}

			const selectedIndex = historyOptions.findIndex(o => o.label === choice);
			if (selectedIndex >= 0) {
				const selectedEntry = pageHistory[selectedIndex];
				await this.manageRecentConversation(ctx, selectedEntry.conversations[0]);
				return;
			}
		}
	}

	private buildHistoryOptions(messages: import("../models/whatsapp.types.js").RecentConversationMessage[]) {
		const assistantName = this.sessionManager.getAssistantName();
		return messages.map((msg) => {
			const marker = msg.direction === "outgoing" ? assistantName : "Received";
			const displayText = this.truncate(msg.text, 60) || "[Empty]";
			const label = `${this.formatDateTimeWithSeconds(msg.timestamp)} • ${marker} • ${displayText}`;
			return { label, message: msg };
		});
	}

	async manageRecents(ctx: ExtensionCommandContext) {
		await manageRecents(this.buildEnv(ctx), ctx);
	}

	async manageContactsList(ctx: ExtensionCommandContext) {
		await manageContactsList(this.buildEnv(ctx), ctx);
	}

	async manageContactDetail(ctx: ExtensionCommandContext, contact: import("./contacts.service.js").SyncedContact) {
		await manageContactDetail(this.buildEnv(ctx), ctx, contact);
	}

	async manageUpdateList(ctx: ExtensionCommandContext) {
		await manageUpdateList(this.buildEnv(ctx), ctx);
	}

	async manageSettings(ctx: ExtensionCommandContext) {
		const env = this.buildEnv(ctx);
		const { manageSettings } = await import("./settings.menu.js");
		await manageSettings(env, ctx);
	}

	// --- Deprecated methods kept for backward compatibility ---

	private async showConversationHistory(
		ctx: ExtensionCommandContext,
		conversation: import("../models/whatsapp.types.js").RecentConversationSummary,
	) {
		await this.showConversationHistoryForContact(
			ctx,
			conversation.senderNumber,
			this.getConversationDisplayName(conversation),
			conversation.senderName
		);
	}

	private getConversationDisplayName(conversation: import("../models/whatsapp.types.js").RecentConversationSummary): string {
		const isGroup = import("../services/session.manager.js").SessionManager.isGroupJid(conversation.senderNumber);
		if (isGroup) {
			const group = this.sessionManager.getAllowedGroup(conversation.senderNumber);
			return group?.name || conversation.senderName || conversation.senderNumber;
		}
		const contact = this.sessionManager.getAllowedContact(conversation.senderNumber);
		return contact?.name || conversation.senderName || conversation.senderNumber;
	}

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen - 3) + "...";
	}

	private formatDateTimeWithSeconds(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleString("en-GB", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	}
}

// --- Inline implementations for backward compatibility ---

function formatContactOption(contact: Contact): string {
	const name = contact.name || contact.notify || contact.phoneNumber || contact.id;
	return `${name} [${contact.number}]`;
}

function formatGroupOption(contact: Contact): string {
	const name = contact.name || contact.id;
	return `${name} [${contact.number}]`;
}

function formatHistoryOption(timestamp: number, direction: string, text: string): string {
	const marker = direction === "outgoing" ? "Agent Pi" : "Received";
	const displayText = text.length > 60 ? text.slice(0, 57) + "..." : (text || "[Empty]");
	const date = new Date(timestamp);
	return `${date.toLocaleString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} • ${marker} • ${displayText}`;
}