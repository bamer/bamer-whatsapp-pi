import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import type { Contact } from "../../services/session.manager.js";
import { validatePhoneNumber } from "../../models/whatsapp.types.js";
import { fileLog } from "../../services/storage-path.js";
import type { MenuEnv } from "./menu-context.js";
import { formatUpdateTargetOption, sortContactsAlphabetically } from "./shared.helpers.js";

export async function manageUpdateList(ctx: ExtensionCommandContext, env: MenuEnv) {
	const list = sortContactsAlphabetically(
		env.sessionManager.getUpdateList(),
	);
	const title = t("menu.updateTargets.title");
	const addNumberLabel = t("menu.updateTargets.addNumber");
	const backLabel = t("menu.root.back");
	const options = [
		...list.map((contact) => formatUpdateTargetOption(contact)),
		addNumberLabel,
		backLabel,
	];

	const choice = await ctx.ui.select(title, options);

	if (choice === addNumberLabel) {
		const num = await ctx.ui.input(t("menu.updateTargets.enterNumber"));
		if (num && validatePhoneNumber(num)) {
			await env.sessionManager.addUpdateNumber(num);
			ctx.ui.notify(t("menu.updateTargets.added", { number: num }), "info");
		} else {
			ctx.ui.notify(t("menu.updateTargets.invalidNumber"), "error");
		}
		await manageUpdateList(ctx, env);
		return;
	}

	if (choice === backLabel || !choice) {
		await env.openRootMenu(ctx);
		return;
	}

	const selectedContact = list.find(
		(contact) => formatUpdateTargetOption(contact) === choice,
	);
	if (!selectedContact) {
		await manageUpdateList(ctx, env);
		return;
	}

	await manageUpdateTarget(ctx, env, selectedContact);
}

export async function manageUpdateTarget(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	contact: Contact,
) {
	const displayName = formatUpdateTargetOption(contact);
	const title = t("menu.updateTargets.target.title", { displayName });
	const printNumberLabel = t("menu.updateTargets.target.printNumber");
	const removeAliasLabel = t("menu.updateTargets.target.removeAlias");
	const addAliasLabel = t("menu.updateTargets.target.addAlias");
	const removeNumberLabel = t("menu.updateTargets.target.removeNumber");
	const backLabel = t("menu.updateTargets.target.back");
	const options = [printNumberLabel];
	if (contact.name) {
		options.push(removeAliasLabel);
	} else {
		options.push(addAliasLabel);
	}
	options.push(removeNumberLabel, backLabel);

	const choice = await ctx.ui.select(title, options);

	if (choice === printNumberLabel) {
		printUpdateTarget(ctx, contact.number);
		await manageUpdateTarget(ctx, env, contact);
		return;
	}

	if (choice === addAliasLabel) {
		const alias = await ctx.ui.input(
			t("menu.updateTargets.enterAlias", { number: contact.number }),
		);
		const trimmedAlias = alias?.trim() || "";
		if (!trimmedAlias) {
			ctx.ui.notify(t("menu.updateTargets.pleaseEnterAlias"), "error");
			await manageUpdateTarget(ctx, env, contact);
			return;
		}
		await env.sessionManager.addUpdateNumber(contact.number, trimmedAlias);
		ctx.ui.notify(
			t("menu.updateTargets.aliasAdded", { number: contact.number }),
			"info",
		);
		await manageUpdateTarget(ctx, env, { ...contact, name: trimmedAlias });
		return;
	}

	if (choice === removeAliasLabel) {
		await env.sessionManager.addUpdateNumber(contact.number);
		ctx.ui.notify(
			t("menu.updateTargets.aliasRemoved", { number: contact.number }),
			"info",
		);
		await manageUpdateTarget(ctx, env, { ...contact, name: undefined });
		return;
	}

	if (choice === removeNumberLabel) {
		const ok = await ctx.ui.confirm(
			t("menu.updateTargets.removeConfirmTitle"),
			t("menu.updateTargets.removeConfirmMessage", { displayName }),
		);
		if (ok) {
			await env.sessionManager.removeUpdateNumber(contact.number);
			ctx.ui.notify(t("menu.updateTargets.removed", { displayName }), "info");
		}
		await manageUpdateList(ctx, env);
		return;
	}

	await manageUpdateList(ctx, env);
}

function printUpdateTarget(
	ctx: ExtensionCommandContext,
	contactNumber: string,
) {
	const output = "  • " + contactNumber;
	fileLog([t("menu.updateTargets.printTitle"), output].join("\n"));
	ctx.ui.notify(contactNumber, "info");
}
