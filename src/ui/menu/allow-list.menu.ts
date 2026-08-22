import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import { validatePhoneNumber } from "../../models/whatsapp.types.js";
import type { Contact } from "../../services/session.manager.js";
import { fileLog } from "../../services/storage-path.js";
import type { MenuEnv } from "./menu-context.js";
import {
	formatAllowedContactOption,
	sendPromptedMenuMessage,
	sortContactsAlphabetically,
} from "./shared.helpers.js";
import { showConversationHistoryForContact } from "./recents.menu.js";

const printedAllowedContacts: string[] = [];

export async function manageAllowList(ctx: ExtensionCommandContext, env: MenuEnv) {
	const list = sortContactsAlphabetically(
		env.sessionManager.getAllowList(),
	);
	const title = t("menu.allowed.title");
	const addNumberLabel = t("menu.allowed.addNumber");
	const backLabel = t("menu.root.back");
	const options = [
		...list.map((contact) => formatAllowedContactOption(contact)),
		addNumberLabel,
		backLabel,
	];

	const choice = await ctx.ui.select(title, options);

	if (choice === addNumberLabel) {
		const num = await ctx.ui.input(t("menu.allowed.enterNumber"));
		if (num && validatePhoneNumber(num)) {
			await env.sessionManager.addNumber(num);
			ctx.ui.notify(
				t("menu.allowed.addedToAllowList", { number: num }),
				"info",
			);
		} else {
			ctx.ui.notify(t("menu.allowed.invalidNumber"), "error");
		}
		await manageAllowList(ctx, env);
		return;
	}

	if (choice === backLabel || !choice) {
		await env.openRootMenu(ctx);
		return;
	}

	const selectedContact = list.find(
		(contact) => formatAllowedContactOption(contact) === choice,
	);
	if (!selectedContact) {
		await manageAllowList(ctx, env);
		return;
	}

	await manageAllowedContact(ctx, env, selectedContact);
}

export async function manageAllowedContact(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	contact: Contact,
) {
	const displayName = formatAllowedContactOption(contact);
	const title = t("menu.allowed.contact.title", { displayName });
	const historyLabel = t("menu.allowed.contact.history");
	const sendMessageLabel = t("menu.allowed.contact.sendMessage");
	const printNumberLabel = t("menu.allowed.contact.printNumber");
	const removeAliasLabel = t("menu.allowed.contact.removeAlias");
	const addAliasLabel = t("menu.allowed.contact.addAlias");
	const removeNumberLabel = t("menu.allowed.contact.removeNumber");
	const addSendNumberLabel = t("menu.allowed.contact.addNumber");
	const removeSendNumberLabel = t("menu.allowed.contact.removeSendNumber");
	const backLabel = t("menu.allowed.contact.back");
	const options = [historyLabel];
	if (contact.sendNumber) {
		options.push(sendMessageLabel);
		options.push(removeSendNumberLabel);
	} else {
		options.push(addSendNumberLabel);
	}
	options.push(printNumberLabel);
	if (contact.name) {
		options.push(removeAliasLabel);
	} else {
		options.push(addAliasLabel);
	}
	options.push(removeNumberLabel, backLabel);

	const choice = await ctx.ui.select(title, options);

	if (choice === addSendNumberLabel) {
		const input = await ctx.ui.input(
			t("menu.allowed.contact.enterNumber", { displayName }),
		);
		const trimmed = input?.trim() || "";
		if (!validatePhoneNumber(trimmed)) {
			ctx.ui.notify(t("menu.allowed.invalidNumber"), "error");
			await manageAllowedContact(ctx, env, contact);
			return;
		}
		await env.sessionManager.setContactSendNumber(contact.number, trimmed);
		ctx.ui.notify(
			t("menu.allowed.contact.numberAdded", { displayName }),
			"info",
		);
		await manageAllowedContact(ctx, env, { ...contact, sendNumber: trimmed });
		return;
	}

	if (choice === removeSendNumberLabel) {
		await env.sessionManager.removeContactSendNumber(contact.number);
		ctx.ui.notify(
			t("menu.allowed.contact.numberRemoved", { displayName }),
			"info",
		);
		await manageAllowedContact(ctx, env, {
			...contact,
			sendNumber: undefined,
		});
		return;
	}

	if (choice === sendMessageLabel) {
		await sendPromptedMenuMessage(ctx, env, {
			displayName,
			senderNumber: contact.sendNumber!,
			senderName: contact.name,
			appendPiSuffix: true,
		});
		await manageAllowedContact(ctx, env, contact);
		return;
	}

	if (choice === historyLabel) {
		await showConversationHistoryForContact(
			ctx,
			env,
			contact.number,
			displayName,
		);
		await manageAllowedContact(ctx, env, contact);
		return;
	}

	if (choice === printNumberLabel) {
		printAllowedContact(ctx, contact.number);
		await manageAllowedContact(ctx, env, contact);
		return;
	}

	if (choice === addAliasLabel) {
		const alias = await ctx.ui.input(
			t("menu.allowed.enterAlias", { number: contact.number }),
		);
		const trimmedAlias = alias?.trim() || "";

		if (!trimmedAlias) {
			ctx.ui.notify(t("menu.allowed.pleaseEnterAlias"), "error");
			await manageAllowedContact(ctx, env, contact);
			return;
		}

		await env.sessionManager.setAllowedContactAlias(
			contact.number,
			trimmedAlias,
		);
		ctx.ui.notify(
			t("menu.allowed.aliasAdded", { number: contact.number }),
			"info",
		);
		await manageAllowedContact(ctx, env, { ...contact, name: trimmedAlias });
		return;
	}

	if (choice === removeAliasLabel) {
		await env.sessionManager.removeAllowedContactAlias(contact.number);
		ctx.ui.notify(
			t("menu.allowed.aliasRemoved", { number: contact.number }),
			"info",
		);
		await manageAllowedContact(ctx, env, { ...contact, name: undefined });
		return;
	}

	if (choice === removeNumberLabel) {
		const ok = await ctx.ui.confirm(
			t("menu.allowed.removeConfirmTitle"),
			t("menu.allowed.removeConfirmMessage", { displayName }),
		);
		if (ok) {
			await env.sessionManager.removeNumber(contact.number);
			ctx.ui.notify(t("menu.allowed.removed", { displayName }), "info");
		}
		await manageAllowList(ctx, env);
		return;
	}

	await manageAllowList(ctx, env);
}

function printAllowedContact(
	ctx: ExtensionCommandContext,
	contactNumber: string,
) {
	printedAllowedContacts.push(contactNumber);
	const output = printedAllowedContacts
		.map((entry) => `  • ${entry}`)
		.join("\n");
	fileLog(
		[t("menu.allowed.printAllowedNumbersTitle"), output].join("\n"),
	);
	ctx.ui.notify(printedAllowedContacts.join("\n"), "info");
}
