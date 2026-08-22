import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as qrcode from "qrcode-terminal";
import { t } from "../i18n.js";
import type { RecentsService } from "../services/recents.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { WhatsAppService } from "../services/whatsapp.service.js";
import { manageAllowList } from "./menu/allow-list.menu.js";
import { manageContactsList } from "./menu/contacts.menu.js";
import { manageAllowedGroups } from "./menu/groups.menu.js";
import type { MenuEnv } from "./menu/menu-context.js";
import { manageRecents } from "./menu/recents.menu.js";
import { manageSettings } from "./menu/settings.menu.js";
import { manageUpdateList } from "./menu/update-targets.menu.js";

/**
 * Facade for the WhatsApp extension menus.
 *
 * Each menu domain lives in its own module under `src/ui/menu/`; this
 * class only owns the root dispatch and forwards the shared service
 * dependencies (MenuEnv) to the domain functions.
 */
export class MenuHandler {
	constructor(
		private readonly whatsappService: WhatsAppService,
		private readonly sessionManager: SessionManager,
		private readonly recentsService: RecentsService,
	) {}

	async handleCommand(ctx: ExtensionCommandContext) {
		const status = this.whatsappService.getEffectiveStatus();
		const registered = await this.sessionManager.isRegistered();
		const title = t("menu.whatsapp.title", { status });
		const recentsLabel = t("menu.root.recents");
		const allowedContactsLabel = t("menu.root.allowedNumbers");
		const allowedGroupsLabel = t("menu.root.allowedGroups");
		const updateTargetsLabel = t("menu.root.updateTargets");
		const disconnectWhatsAppLabel = t("menu.root.disconnectWhatsApp");
		const connectWhatsAppLabel = t("menu.root.connectWhatsApp");
		const logoffDeleteSessionLabel = t("menu.root.logoffDeleteSession");
		const settingsLabel = t("menu.root.settings");
		const backLabel = t("menu.root.back");
		const options: string[] = [];

		if (status === "connected") {
			options.push(recentsLabel);
			options.push(t("menu.root.contactsList"));
			options.push(allowedContactsLabel);
			options.push(allowedGroupsLabel);
			options.push(updateTargetsLabel);
			options.push(disconnectWhatsAppLabel);
		} else {
			options.push(connectWhatsAppLabel);
		}

		if (registered) {
			options.push(logoffDeleteSessionLabel);
		}

		options.push(settingsLabel);
		options.push(backLabel);

		const choice = await ctx.ui.select(title, options);

		switch (choice) {
			case connectWhatsAppLabel:
				if (status === "connected") {
					ctx.ui.notify(t("menu.root.alreadyConnected"), "info");
					break;
				}
				this.whatsappService.setQRCodeCallback((qr) => {
					qrcode.generate(qr, { small: true });
				});
				await this.whatsappService.start();
				ctx.ui.notify(
					registered ?
						t("menu.root.reconnectStarted")
					:	t("menu.root.pairingStarted"),
					"info",
				);
				break;
			case disconnectWhatsAppLabel:
				if (status !== "connected") {
					ctx.ui.notify(t("menu.root.alreadyDisconnected"), "info");
					break;
				}
				await this.whatsappService.stop();
				ctx.ui.notify(t("menu.root.agentDisconnected"), "warning");
				break;
			case logoffDeleteSessionLabel: {
				const confirmLogoff = await ctx.ui.confirm(
					t("menu.root.logoffTitle"),
					t("menu.root.logoffConfirmMessage"),
				);
				if (confirmLogoff) {
					await this.whatsappService.logout();
					ctx.ui.notify(t("menu.root.loggedOffAndDeleted"), "info");
				}
				break;
			}
			case allowedContactsLabel:
				await manageAllowList(ctx, this.env());
				break;
			case allowedGroupsLabel:
				await manageAllowedGroups(ctx, this.env());
				break;
			case updateTargetsLabel:
				await manageUpdateList(ctx, this.env());
				break;
			case t("menu.root.contactsList"):
				await manageContactsList(ctx, this.env());
				break;
			case recentsLabel:
				await manageRecents(ctx, this.env());
				break;
			case settingsLabel:
				await manageSettings(ctx, this.env());
				break;
		}
	}

	private env(): MenuEnv {
		return {
			whatsappService: this.whatsappService,
			sessionManager: this.sessionManager,
			recentsService: this.recentsService,
			openRootMenu: (ctx) => this.handleCommand(ctx),
		};
	}
}
