import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RecentsService } from "../../services/recents.service.js";
import type { SessionManager } from "../../services/session.manager.js";
import type { WhatsAppService } from "../../services/whatsapp.service.js";

/**
 * Services every menu module needs. The MenuHandler facade owns the
 * instances and forwards them on each call — menu modules stay pure
 * functions with no hidden state.
 */
export interface MenuDeps {
	whatsappService: WhatsAppService;
	sessionManager: SessionManager;
	recentsService: RecentsService;
}

/**
 * Full environment handed to menu modules: services plus a callback
 * that re-opens the root menu (avoids circular imports between the
 * facade and the domain modules).
 */
export interface MenuEnv extends MenuDeps {
	openRootMenu(ctx: ExtensionCommandContext): Promise<void>;
}