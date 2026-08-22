import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import type { RecentConversationSummary } from "../../models/whatsapp.types.js";
import { SessionManager } from "../../services/session.manager.js";
import { showMessageDetailView } from "../message-detail.view.js";
import { showMessageReplyView } from "../message-reply.view.js";
import type { MenuEnv } from "./menu-context.js";
import {
	buildHistoryOptions,
	formatGroupedRecentOption,
	getConversationDisplayName,
	groupRecentConversations,
	resolveHistorySelection,
	sortHistoryByMostRecent,
} from "./shared.helpers.js";

export async function manageRecents(ctx: ExtensionCommandContext, env: MenuEnv) {
	const recentConversations =
		await env.recentsService.getRecentConversations();
	const groupedEntries = groupRecentConversations(recentConversations);
	const title = t("menu.recents.title");
	const backLabel = t("menu.root.back");
	const nextLabel = "Next";
	const previousLabel = "Previous";
	const pageSize = 10;

	if (groupedEntries.length === 0) {
		ctx.ui.notify(t("menu.recents.empty"), "info");
		await env.openRootMenu(ctx);
		return;
	}

	for (let page = 0; page * pageSize < groupedEntries.length; ) {
		const start = page * pageSize;
		const pageEntries = groupedEntries.slice(start, start + pageSize);
		const options = [
			...pageEntries.map((entry) => formatGroupedRecentOption(env, entry)),
			...(page > 0 ? [previousLabel] : []),
			...(start + pageSize < groupedEntries.length ? [nextLabel] : []),
			backLabel,
		];

		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === backLabel) {
			await env.openRootMenu(ctx);
			return;
		}

		if (choice === nextLabel) {
			page += 1;
			continue;
		}

		if (choice === previousLabel) {
			page = Math.max(0, page - 1);
			continue;
		}

		const selectedEntry = pageEntries.find(
			(entry) => formatGroupedRecentOption(env, entry) === choice,
		);

		if (!selectedEntry) {
			return;
		}

		await manageRecentConversation(ctx, env, selectedEntry.conversations[0]);
		return;
	}
}

export async function manageRecentConversation(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	conversation: RecentConversationSummary,
) {
	const displayName = getConversationDisplayName(env, conversation);
	const isGroup = SessionManager.isGroupJid(conversation.senderNumber);
	const allowedContact =
		isGroup ?
			env.sessionManager.getAllowedGroup(conversation.senderNumber)
		:	env.sessionManager.getAllowedContact(conversation.senderNumber);
	const title = t("menu.recents.contact.title", { displayName });
	const historyLabel = t("menu.recents.contact.history");
	const allowContactLabel =
		isGroup ?
			t("menu.recents.contact.allowGroup")
		:	t("menu.recents.contact.allowNumber");
	const removeAliasLabel = t("menu.recents.contact.removeAlias");
	const backLabel = t("menu.recents.contact.back");
	const addToUpdateListLabel = t("menu.recents.contact.addToUpdateList");
	const isInUpdateList =
		!isGroup &&
		env.sessionManager.isAllowedUpdateTarget(conversation.senderNumber);
	const options: string[] = [historyLabel];

	if (!allowedContact) {
		options.push(allowContactLabel);
	}

	if (!isGroup && !isInUpdateList) {
		options.push(addToUpdateListLabel);
	}

	if (allowedContact?.name) {
		options.push(removeAliasLabel);
	}

	options.push(backLabel);

	const choice = await ctx.ui.select(title, options);

	if (choice === allowContactLabel) {
		if (
			env.sessionManager.isConversationAllowed(conversation.senderNumber)
		) {
			ctx.ui.notify(
				t("menu.recents.alreadyAllowed", {
					number: conversation.senderNumber,
				}),
				"info",
			);
		} else if (isGroup) {
			await env.sessionManager.addAllowedGroup(
				conversation.senderNumber,
				conversation.senderName,
			);
			ctx.ui.notify(
				t("menu.recents.addedGroupToAllowList", {
					groupJid: conversation.senderNumber,
				}),
				"info",
			);
		} else {
			await env.sessionManager.addNumber(
				conversation.senderNumber,
				conversation.senderName,
			);
			ctx.ui.notify(
				t("menu.recents.addedToAllowList", {
					number: conversation.senderNumber,
				}),
				"info",
			);
		}
		await manageRecentConversation(ctx, env, conversation);
		return;
	}

	if (choice === addToUpdateListLabel) {
		if (
			await env.sessionManager.isAllowedUpdateTarget(conversation.senderNumber)
		) {
			ctx.ui.notify(
				t("menu.recents.alreadyInUpdateList", {
					number: conversation.senderNumber,
				}),
				"info",
			);
		} else {
			await env.sessionManager.addUpdateNumber(
				conversation.senderNumber,
				conversation.senderName,
			);
			ctx.ui.notify(
				t("menu.recents.addedToUpdateList", {
					number: conversation.senderNumber,
				}),
				"info",
			);
		}
		await manageRecentConversation(ctx, env, conversation);
		return;
	}

	if (choice === removeAliasLabel) {
		if (isGroup) {
			await env.sessionManager.removeAllowedGroupAlias(
				conversation.senderNumber,
			);
		} else {
			await env.sessionManager.removeAllowedContactAlias(
				conversation.senderNumber,
			);
		}
		ctx.ui.notify(
			t("menu.recents.aliasRemoved", { number: conversation.senderNumber }),
			"info",
		);
		await manageRecentConversation(ctx, env, {
			...conversation,
			senderName: undefined,
		});
		return;
	}

	if (choice === historyLabel) {
		await showConversationHistory(ctx, env, conversation);
		await manageRecentConversation(ctx, env, conversation);
		return;
	}

	await manageRecents(ctx, env);
}

export async function showConversationHistory(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	conversation: RecentConversationSummary,
) {
	await showConversationHistoryForContact(
		ctx,
		env,
		conversation.senderNumber,
		getConversationDisplayName(env, conversation),
		conversation.senderName,
	);
}

export async function showConversationHistoryForContact(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	senderNumber: string,
	displayName: string,
	senderName?: string,
) {
	const history =
		await env.recentsService.getConversationHistory(senderNumber);

	if (history.length === 0) {
		ctx.ui.notify(t("menu.recents.history.empty"), "info");
		return;
	}

	const sortedHistory = sortHistoryByMostRecent(history);
	const pageSize = 10;
	const backLabel = t("menu.root.back");
	const nextLabel = "Next";
	const previousLabel = "Previous";

	for (let page = 0; page * pageSize < sortedHistory.length; ) {
		const start = page * pageSize;
		const pageHistory = sortedHistory.slice(start, start + pageSize);
		const historyOptions = buildHistoryOptions(env.sessionManager, pageHistory);
		const choice = await ctx.ui.select(
			t("menu.recents.history.title", { displayName }),
			[
				...historyOptions.map((option) => option.label),
				...(page > 0 ? [previousLabel] : []),
				...(start + pageSize < sortedHistory.length ? [nextLabel] : []),
				backLabel,
			],
		);

		if (!choice || choice === backLabel) {
			return;
		}

		if (choice === nextLabel) {
			page += 1;
			continue;
		}

		if (choice === previousLabel) {
			page = Math.max(0, page - 1);
			continue;
		}

		const selectedMessage = resolveHistorySelection(
			choice,
			historyOptions,
		);
		if (!selectedMessage) {
			return;
		}

		const detailAction = await showMessageDetailView(ctx, {
			title: t("menu.recents.history.messageTitle", { displayName }),
			messageId: selectedMessage.messageId,
			senderNumber: selectedMessage.senderNumber,
			senderName,
			text: selectedMessage.text,
			direction: selectedMessage.direction,
			timestamp: selectedMessage.timestamp,
			assistantName: env.sessionManager.getAssistantName(),
		});

		if (detailAction === "reply") {
			await showMessageReplyView(ctx, {
				selectedMessage: {
					messageId: selectedMessage.messageId,
					senderNumber: selectedMessage.senderNumber,
					senderName,
					text: selectedMessage.text,
					direction: selectedMessage.direction,
					timestamp: selectedMessage.timestamp,
				},
				whatsappService: env.whatsappService,
				recentsService: env.recentsService,
			});
		}
	}
}
