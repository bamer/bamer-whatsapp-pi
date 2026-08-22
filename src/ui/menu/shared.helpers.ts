import { t } from "../../i18n.js";
import type { RecentConversationMessage, RecentConversationSummary } from "../../models/whatsapp.types.js";
import { SessionManager, type Contact } from "../../services/session.manager.js";
import type { MenuDeps } from "./menu-context.js";

export interface HistoryOptionEntry {
	label: string;
	message: RecentConversationMessage;
}

export function formatAllowedContactOption(contact: Contact): string {
	const base =
		contact.name ? `${contact.name} [${contact.number}]` : contact.number;
	return contact.sendNumber ? `${base} (${contact.sendNumber})` : base;
}

export function formatAllowedGroupOption(group: Contact): string {
	return group.name ? `${group.name} (${group.number})` : group.number;
}

export function formatUpdateTargetOption(contact: Contact): string {
	return contact.name ?
			`${contact.name} [${contact.number}]`
		:	contact.number;
}

function formatAllowedContactSortKey(contact: Contact): string {
	return contact.name ? `${contact.name} ${contact.number}` : contact.number;
}

export function sortContactsAlphabetically(contacts: Contact[]): Contact[] {
	return [...contacts].sort((left, right) => {
		const leftLabel = formatAllowedContactSortKey(left);
		const rightLabel = formatAllowedContactSortKey(right);
		return leftLabel.localeCompare(rightLabel, undefined, {
			sensitivity: "base",
		});
	});
}

export function toJid(number: string): string {
	if (number.includes("@")) {
		return number;
	}
	const normalized = number.startsWith("+") ? number.slice(1) : number;
	return `${normalized}@s.whatsapp.net`;
}

export function formatDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "short",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

export function formatDateTimeWithSeconds(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "short",
		timeStyle: "medium",
	}).format(new Date(timestamp));
}

export function truncate(value: string, maxLength: number): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (!normalized) {
		return "";
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

// --- History helpers ---

export function sortHistoryByMostRecent<T extends { timestamp: number }>(
	history: T[],
): T[] {
	return [...history].sort((left, right) => {
		const dayComparison =
			getDayStart(right.timestamp) - getDayStart(left.timestamp);
		if (dayComparison !== 0) {
			return dayComparison;
		}
		return getTimeOfDay(right.timestamp) - getTimeOfDay(left.timestamp);
	});
}

function getTimeOfDay(timestamp: number): number {
	const date = new Date(timestamp);
	return (
		date.getHours() * 60 * 60 * 1000 +
		date.getMinutes() * 60 * 1000 +
		date.getSeconds() * 1000 +
		date.getMilliseconds()
	);
}

function getDayStart(timestamp: number): number {
	const date = new Date(timestamp);
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
	).getTime();
}

export function buildHistoryOptions(
	sessionManager: SessionManager,
	history: RecentConversationMessage[],
): HistoryOptionEntry[] {
	return history.map((message) => ({
		label: formatHistoryOption(
			sessionManager,
			message.timestamp,
			message.direction,
			message.text,
		),
		message,
	}));
}

export function formatHistoryOption(
	sessionManager: SessionManager,
	timestamp: number,
	direction: string,
	text: string,
): string {
	const assistantName = sessionManager.getAssistantName();
	const marker =
		direction === "outgoing" ? assistantName : (
			t("menu.recents.history.received")
		);
	const displayText =
		truncate(text, 60) || t("menu.recents.history.noText");
	return `${formatDateTimeWithSeconds(timestamp)} • ${marker} • ${displayText}`;
}

export function resolveHistorySelection(
	choice: string,
	options: HistoryOptionEntry[],
): RecentConversationMessage | undefined {
	return options.find((option) => option.label === choice)?.message;
}

// --- Recents grouping helpers ---

interface GroupedRecentEntry {
	conversations: RecentConversationSummary[];
	sharedPreview: string;
	sharedTime: number;
}

export function getRecentsGroupKey(conversation: RecentConversationSummary): string {
	if (conversation.lastMessageDirection === "outgoing") {
		return `outgoing::${conversation.senderNumber}`;
	}
	const d = new Date(conversation.lastMessageTime);
	const minuteKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
	return `${conversation.lastMessagePreview}::${minuteKey}`;
}

export function groupRecentConversations(
	conversations: RecentConversationSummary[],
): GroupedRecentEntry[] {
	const groups = new Map<string, RecentConversationSummary[]>();
	for (const conversation of conversations) {
		const key = getRecentsGroupKey(conversation);
		const existing = groups.get(key) ?? [];
		existing.push(conversation);
		groups.set(key, existing);
	}
	return Array.from(groups.values()).map((members) => ({
		conversations: members,
		sharedPreview: members[0].lastMessagePreview,
		sharedTime: members[0].lastMessageTime,
	}));
}

export function getConversationDisplayName(
	deps: Pick<MenuDeps, "sessionManager">,
	conversation: RecentConversationSummary,
): string {
	const isGroup = SessionManager.isGroupJid(conversation.senderNumber);
	const allowedContact =
		isGroup ?
			deps.sessionManager.getAllowedGroup(conversation.senderNumber)
		:	deps.sessionManager.getAllowedContact(conversation.senderNumber);
	const displayName = allowedContact?.name || conversation.senderName;
	const prefix = isGroup ? "[Group] " : "";
	return displayName ?
			`${prefix}${displayName} (${conversation.senderNumber})`
		:	`${prefix}${conversation.senderNumber}`;
}

export function formatGroupedRecentOption(
	deps: Pick<MenuDeps, "sessionManager">,
	entry: GroupedRecentEntry,
): string {
	if (entry.conversations.length === 1) {
		return formatRecentConversationOption(deps, entry.conversations[0]);
	}
	const time = formatDateTime(entry.sharedTime);
	const identifiers = entry.conversations
		.map((c) =>
			c.senderName ?
				`[${c.senderNumber}] ${c.senderName}`
			:	`(${c.senderNumber})`,
		)
		.join(" ");
	return `${identifiers} • ${time} • ${entry.sharedPreview}`;
}

export function formatRecentConversationOption(
	deps: Pick<MenuDeps, "sessionManager">,
	conversation: RecentConversationSummary,
): string {
	const displayName = getConversationDisplayName(deps, conversation);
	const time = formatDateTime(conversation.lastMessageTime);
	return `${displayName} • ${time} • ${conversation.lastMessagePreview}`;
}

// --- Outgoing menu messages ---

/**
 * Prompts for a message body and sends it through the menu path.
 * One retry when the prompt comes back empty; appends the agent
 * signature when requested.
 */
export async function sendPromptedMenuMessage(
	ctx: { ui: { input(prompt: string): Promise<string | undefined>; notify(message: string, level: "info" | "error" | "warning"): void } },
	deps: MenuDeps,
	options: {
		displayName: string;
		senderNumber: string;
		senderName?: string;
		appendPiSuffix: boolean;
	},
): Promise<void> {
	const { displayName, senderNumber, senderName, appendPiSuffix } = options;
	for (let attempt = 0; attempt < 2; attempt++) {
		const inputText =
			(
				await ctx.ui.input(t("menu.allowed.sendPrompt", { displayName }))
			)?.trim() || "";

		if (!inputText) {
			ctx.ui.notify(t("menu.allowed.messageRequired"), "error");
			continue;
		}

		const signature = appendPiSuffix ? deps.sessionManager.getAgentSignature() : '';
		const messageText = signature ? `${inputText} ${signature}` : inputText;
		const result = await deps.whatsappService.sendMenuMessage(
			toJid(senderNumber),
			messageText,
		);
		if (result.success) {
			await deps.recentsService.recordMessage({
				messageId: result.messageId ?? `${Date.now()}`,
				senderNumber,
				senderName,
				text: messageText,
				direction: "outgoing",
				timestamp: Date.now(),
			});
			ctx.ui.notify(t("menu.allowed.sendSuccess", { displayName }), "info");
		} else {
			ctx.ui.notify(
				t("menu.allowed.sendFailure", {
					displayName,
					error: result.error ?? "Unknown error",
				}),
				"error",
			);
		}
		return;
	}
}