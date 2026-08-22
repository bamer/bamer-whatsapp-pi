import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import { SessionManager, type Contact } from "../../services/session.manager.js";
import { fileLog } from "../../services/storage-path.js";
import type { MenuEnv } from "./menu-context.js";
import { showConversationHistoryForContact } from "./recents.menu.js";
import {
	formatAllowedGroupOption,
	sendPromptedMenuMessage,
	sortContactsAlphabetically,
} from "./shared.helpers.js";

const printedAllowedGroups: string[] = [];

export async function manageAllowedGroups(ctx: ExtensionCommandContext, env: MenuEnv) {
	const list = sortContactsAlphabetically(
		env.sessionManager.getAllowedGroups(),
	);
	const title = t("menu.allowedGroups.title");
	const addGroupLabel = t("menu.allowedGroups.addGroup");
	const backLabel = t("menu.root.back");
	const options = [
		...list.map((group) => formatAllowedGroupOption(group)),
		addGroupLabel,
		backLabel,
	];

	const choice = await ctx.ui.select(title, options);

	if (choice === addGroupLabel) {
		const groupJid = await ctx.ui.input(t("menu.allowedGroups.enterGroup"));
		if (groupJid && SessionManager.isGroupJid(groupJid)) {
			await env.sessionManager.addAllowedGroup(groupJid);
			ctx.ui.notify(
				t("menu.allowedGroups.addedToAllowList", { groupJid }),
				"info",
			);
		} else {
			ctx.ui.notify(t("menu.allowedGroups.invalidGroup"), "error");
		}
		await manageAllowedGroups(ctx, env);
		return;
	}

	if (choice === backLabel || !choice) {
		await env.openRootMenu(ctx);
		return;
	}

	const selectedGroup = list.find(
		(group) => formatAllowedGroupOption(group) === choice,
	);
	if (!selectedGroup) {
		await manageAllowedGroups(ctx, env);
		return;
	}

	await manageAllowedGroup(ctx, env, selectedGroup);
}

export async function manageAllowedGroup(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	group: Contact,
) {
	const displayName = formatAllowedGroupOption(group);
	const title = t("menu.allowedGroups.group.title", { displayName });
	const historyLabel = t("menu.allowedGroups.group.history");
	const sendMessageLabel = t("menu.allowedGroups.group.sendMessage");
	const printGroupLabel = t("menu.allowedGroups.group.printGroup");
	const removeAliasLabel = t("menu.allowedGroups.group.removeAlias");
	const addAliasLabel = t("menu.allowedGroups.group.addAlias");
	const removeGroupLabel = t("menu.allowedGroups.group.removeGroup");
	const backLabel = t("menu.allowedGroups.group.back");
	const options = [historyLabel, sendMessageLabel, printGroupLabel];
	if (group.name) {
		options.push(removeAliasLabel);
	} else {
		options.push(addAliasLabel);
	}
	options.push(removeGroupLabel, backLabel);

	const choice = await ctx.ui.select(title, options);

	if (choice === sendMessageLabel) {
		await sendPromptedMenuMessage(ctx, env, {
			displayName,
			senderNumber: group.number,
			senderName: group.name,
			appendPiSuffix: true,
		});
		await manageAllowedGroup(ctx, env, group);
		return;
	}

	if (choice === historyLabel) {
		await showConversationHistoryForContact(
			ctx,
			env,
			group.number,
			displayName,
		);
		await manageAllowedGroup(ctx, env, group);
		return;
	}

	if (choice === printGroupLabel) {
		printAllowedGroup(ctx, group.number);
		await manageAllowedGroup(ctx, env, group);
		return;
	}

	if (choice === addAliasLabel) {
		const alias = await ctx.ui.input(
			t("menu.allowedGroups.enterAlias", { groupJid: group.number }),
		);
		const trimmedAlias = alias?.trim() || "";

		if (!trimmedAlias) {
			ctx.ui.notify(t("menu.allowedGroups.pleaseEnterAlias"), "error");
			await manageAllowedGroup(ctx, env, group);
			return;
		}

		await env.sessionManager.setAllowedGroupAlias(
			group.number,
			trimmedAlias,
		);
		ctx.ui.notify(
			t("menu.allowedGroups.aliasAdded", { groupJid: group.number }),
			"info",
		);
		await manageAllowedGroup(ctx, env, { ...group, name: trimmedAlias });
		return;
	}

	if (choice === removeAliasLabel) {
		await env.sessionManager.removeAllowedGroupAlias(group.number);
		ctx.ui.notify(
			t("menu.allowedGroups.aliasRemoved", { groupJid: group.number }),
			"info",
		);
		await manageAllowedGroup(ctx, env, { ...group, name: undefined });
		return;
	}

	if (choice === removeGroupLabel) {
		const ok = await ctx.ui.confirm(
			t("menu.allowedGroups.removeConfirmTitle"),
			t("menu.allowedGroups.removeConfirmMessage", { displayName }),
		);
		if (ok) {
			await env.sessionManager.removeAllowedGroup(group.number);
			ctx.ui.notify(t("menu.allowedGroups.removed", { displayName }), "info");
		}
		await manageAllowedGroups(ctx, env);
		return;
	}

	await manageAllowedGroups(ctx, env);
}

function printAllowedGroup(ctx: ExtensionCommandContext, groupJid: string) {
	printedAllowedGroups.push(groupJid);
	const output = printedAllowedGroups
		.map((entry) => `  • ${entry}`)
		.join("\n");
	fileLog(
		[t("menu.allowedGroups.printAllowedGroupsTitle"), output].join("\n"),
	);
	ctx.ui.notify(printedAllowedGroups.join("\n"), "info");
}
