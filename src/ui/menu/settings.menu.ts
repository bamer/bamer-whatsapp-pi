import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import { fileLog } from "../../services/storage-path.js";
import type { MenuEnv } from "./menu-context.js";

export async function manageSettings(ctx: ExtensionCommandContext, env: MenuEnv) {
	const { sessionManager, whatsappService } = env;
	const brandVisibility = sessionManager.getBrandVisibility();
	const autoConnect = sessionManager.getAutoConnect();
	const assistantName = sessionManager.getAssistantName();
	const agentSignature = sessionManager.getAgentSignature();
	const logMaxSizeMB = sessionManager.getLogMaxSizeMB();
	const logRetentionDays = sessionManager.getLogRetentionDays();
	const title = t("menu.settings.title");
	const brandVisibilityLabel =
		brandVisibility ?
			t("menu.settings.brandVisibilityYes")
		:	t("menu.settings.brandVisibilityNo");
	const autoConnectLabel =
		autoConnect ?
			t("menu.settings.autoConnectYes")
		:	t("menu.settings.autoConnectNo");
	const assistantNameLabel = `${t("menu.settings.assistantName")}: ${assistantName}`;
	const agentSignatureLabel = `${t("menu.settings.agentSignature")}: ${agentSignature || '(none)'}`;
	const logMaxSizeLabel = t("menu.settings.logMaxSize", { value: logMaxSizeMB });
	const logRetentionLabel = t("menu.settings.logRetention", { value: logRetentionDays });
	const backLabel = t("menu.settings.back");
	const options = [
		brandVisibilityLabel,
		autoConnectLabel,
		assistantNameLabel,
		agentSignatureLabel,
		logMaxSizeLabel,
		logRetentionLabel,
		t("menu.settings.fetchContacts"),
		t("menu.settings.reclassifyContacts"),
		backLabel,
	];

	const choice = await ctx.ui.select(title, options);

	if (choice === brandVisibilityLabel) {
		const newValue = !brandVisibility;
		await sessionManager.setBrandVisibility(newValue);
		ctx.ui.notify(
			t("menu.settings.brandVisibilitySet", {
				value: newValue ? "Yes" : "No",
			}),
			"info",
		);
		await manageSettings(ctx, env);
		return;
	}

	if (choice === autoConnectLabel) {
		const newValue = !autoConnect;
		await sessionManager.setAutoConnect(newValue);
		ctx.ui.notify(
			t("menu.settings.autoConnectSet", { value: newValue ? "Yes" : "No" }),
			"info",
		);
		await manageSettings(ctx, env);
		return;
	}

	if (choice === assistantNameLabel) {
		const newName = await ctx.ui.input(
			t("menu.settings.assistantNamePrompt"),
		);
		if (newName && newName.trim()) {
			await sessionManager.setAssistantName(newName.trim());
			ctx.ui.notify(
				t("menu.settings.assistantNameSet", { value: newName.trim() }),
				"info",
			);
		}
		await manageSettings(ctx, env);
		return;
	}

	if (choice === agentSignatureLabel) {
		const newSig = await ctx.ui.input(
			t("menu.settings.agentSignaturePrompt"),
		);
		// Cancel (null) keeps current value; empty string explicitly clears it.
		if (newSig != null) {
			const trimmed = newSig.trim();
			await sessionManager.setAgentSignature(trimmed);
			ctx.ui.notify(
				t("menu.settings.agentSignatureSet", { value: trimmed || "(none)" }),
				"info",
			);
		}
		await manageSettings(ctx, env);
		return;
	}

	if (choice === logMaxSizeLabel) {
		const raw = await ctx.ui.input(t("menu.settings.logMaxSizePrompt"));
		if (raw && raw.trim()) {
			const size = Number(raw);
			if (!Number.isNaN(size)) {
				const clamped = Math.max(0, Math.min(20, Math.round(size)));
				await sessionManager.setLogMaxSizeMB(clamped);
				ctx.ui.notify(t("menu.settings.logMaxSizeSet", { value: clamped }), "info");
			} else {
				ctx.ui.notify(t("menu.settings.logMaxSizePrompt"), "error");
			}
		}
		await manageSettings(ctx, env);
		return;
	}

	if (choice === logRetentionLabel) {
		const raw = await ctx.ui.input(t("menu.settings.logRetentionPrompt"));
		if (raw && raw.trim()) {
			const days = Number(raw);
			if (!Number.isNaN(days)) {
				const clamped = Math.max(0, Math.min(365, Math.round(days)));
				await sessionManager.setLogRetentionDays(clamped);
				ctx.ui.notify(t("menu.settings.logRetentionSet", { value: clamped }), "info");
			} else {
				ctx.ui.notify(t("menu.settings.logRetentionPrompt"), "error");
			}
		}
		await manageSettings(ctx, env);
		return;
	}

	if (choice === t("menu.settings.fetchContacts")) {
		const socket = whatsappService.getSocket();
		if (!socket?.groupFetchAllParticipating) {
			ctx.ui.notify(t("menu.settings.fetchContactsNoSocket"), "error");
			await manageSettings(ctx, env);
			return;
		}
		ctx.ui.notify(t("menu.settings.fetchContactsFetching"), "info");
		try {
			const result = await whatsappService.getContactsService().fetchContactsFromGroups(socket);
			ctx.ui.notify(
				t("menu.settings.fetchContactsResult", { groups: result.groups, contacts: result.contacts }),
				"info",
			);
		} catch (err) {
			ctx.ui.notify(t("menu.settings.fetchContactsError", { error: String(err) }), "error");
		}
		await manageSettings(ctx, env);
		return;
	}

	if (choice === t("menu.settings.reclassifyContacts")) {
		const result = whatsappService.getContactsService().reclassifyContacts();
		ctx.ui.notify(
			t("menu.settings.reclassifyResult", { upgraded: result.upgraded, total: result.total }),
			"info",
		);
		await manageSettings(ctx, env);
		return;
	}

	await env.openRootMenu(ctx);
}
