import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import { t } from "../../i18n.js";
import { createStoragePaths } from "../../services/storage-path.js";
import type { MenuEnv } from "./menu-context.js";

export interface SavedProfilePicture {
	url: string;
	base64: string;
	mimeType: string;
	/** Local file path of the saved picture. */
	path: string;
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType.includes("png")) return "png";
	if (mimeType.includes("webp")) return "webp";
	return "jpg";
}

/** Save a picture under whatsapp-medias/photos so it can be shown or re-sent later. */
export async function saveProfilePicture(
	jid: string,
	picture: { base64: string; mimeType: string },
): Promise<string> {
	const dir = join(createStoragePaths().mediaDir, "photos");
	await mkdir(dir, { recursive: true });
	const safeJid = jid.replace(/[^a-zA-Z0-9._-]/g, "_");
	const path = join(
		dir,
		`${safeJid}.${extensionForMimeType(picture.mimeType)}`,
	);
	await writeFile(path, Buffer.from(picture.base64, "base64"));
	return path;
}

/**
 * Fetch the avatar of a contact or a group and display it in the terminal.
 * Returns the saved picture, or null when WhatsApp has no photo for that JID.
 */
export async function showProfilePhoto(
	ctx: ExtensionCommandContext,
	env: MenuEnv,
	jid: string,
	displayName: string,
): Promise<SavedProfilePicture | null> {
	const picture = await env.whatsappService
		.getContactsService()
		.fetchProfilePicture(jid);
	if (!picture) {
		ctx.ui.notify(t("menu.photo.unavailable", { displayName }), "warning");
		return null;
	}

	const path = await saveProfilePicture(jid, picture);
	const fileName = path.split("/").pop() ?? "photo.jpg";

	// Render the real image in the TUI (kitty/iterm2); other terminals get the
	// image fallback line plus the saved path below.
	try {
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
			const image = new Image(
				picture.base64,
				picture.mimeType,
				{ fallbackColor: (text: string) => theme.fg("muted", text) },
				{ maxWidthCells: 48, filename: fileName },
			);
			return {
				render: (width: number) => image.render(width),
				invalidate: () => image.invalidate(),
				handleInput: (data: string) => {
					if (data === "\x1b" || data === "\x03") done(undefined);
				},
			};
		});
	} catch {
		// No interactive UI (print/RPC mode) — the saved path is still reported.
	}

	ctx.ui.notify(
		t("menu.photo.saved", { displayName, path, url: picture.url }),
		"info",
	);
	return { ...picture, path };
}
