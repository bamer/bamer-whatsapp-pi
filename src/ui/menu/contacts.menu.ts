import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n.js";
import type { SyncedContact } from "../../services/contacts.service.js";
import { fileLog } from "../../services/storage-path.js";
import { SearchableContactList } from "../searchable-list.js";
import type { MenuEnv } from "./menu-context.js";

export async function manageContactsList(ctx: ExtensionCommandContext, env: MenuEnv) {
	const contactsService = env.whatsappService.getContactsService();
	const totalCount = contactsService.getCount();
	const personalCount = contactsService.getCountBySource("addressbook");
	const groupCount = contactsService.getCountBySource("group");
	fileLog(`[Menu] manageContactsList: total=${totalCount} personal=${personalCount} group=${groupCount}`);

	if (totalCount === 0) {
		ctx.ui.notify(t("menu.contacts.empty"), "info");
		await env.openRootMenu(ctx);
		return;
	}

	// Step 1: choose filter
	const filterTitle = t("menu.contacts.filterTitle");
	const filterOptions = [
		t("menu.contacts.filterPersonal", { count: personalCount }),
		t("menu.contacts.filterGroup", { count: groupCount }),
		t("menu.contacts.filterAll", { count: totalCount }),
		t("menu.root.back"),
	];
	const filterChoice = await ctx.ui.select(filterTitle, filterOptions);
	fileLog(`[Menu] contacts filter choice: ${filterChoice}`);
	if (!filterChoice || filterChoice === t("menu.root.back")) {
		await env.openRootMenu(ctx);
		return;
	}

	// Step 2: filter contacts by source
	let contacts: SyncedContact[];
	if (filterChoice.startsWith(t("menu.contacts.filterPersonal", { count: personalCount }).split(" (")[0])) {
		contacts = contactsService.getContactsBySource("addressbook");
	} else if (filterChoice.startsWith(t("menu.contacts.filterGroup", { count: groupCount }).split(" (")[0])) {
		contacts = contactsService.getContactsBySource("group");
	} else {
		contacts = contactsService.getAllContacts();
	}

	if (contacts.length === 0) {
		ctx.ui.notify(t("menu.contacts.empty"), "info");
		await manageContactsList(ctx, env);
		return;
	}

	// Step 3: searchable list via ctx.ui.custom()
	const items = contacts.map((c) => ({
		value: c.id,
		label: c.name || c.notify || c.phoneNumber || c.id,
		description: c.id,
	}));

	const selectedJid = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const list = new SearchableContactList(items, theme);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		return list;
	});

	fileLog(`[Menu] searchable list selected: ${selectedJid}`);
	if (!selectedJid) {
		await manageContactsList(ctx, env);
		return;
	}

	const selected = contacts.find((c) => c.id === selectedJid);
	if (selected) {
		await manageContactDetail(ctx, env, selected);
	} else {
		await manageContactsList(ctx, env);
	}
}

export async function manageContactDetail(ctx: ExtensionCommandContext, env: MenuEnv, contact: SyncedContact) {
	const displayName = contact.name || contact.notify || contact.id;
	const title = t("menu.contacts.contact.title", { displayName });
	const backLabel = t("menu.root.back");
	const fetchPhotoLabel = t("menu.contacts.contact.fetchPhoto");

	// Show details via notify (console.log breaks Pi TUI rendering)
	const lines: string[] = [];
	if (contact.name) lines.push(t("menu.contacts.contact.name", { name: contact.name }));
	if (contact.phoneNumber) lines.push(t("menu.contacts.contact.phone", { phone: contact.phoneNumber }));
	if (contact.lid) lines.push(t("menu.contacts.contact.lid", { lid: contact.lid }));
	if (contact.status) lines.push(t("menu.contacts.contact.status", { status: contact.status }));
	lines.push(`ID: ${contact.id}`);
	ctx.ui.notify([title, ...lines].join("\n"), "info");

	const options = [fetchPhotoLabel, backLabel];
	const choice = await ctx.ui.select(title, options);

	if (choice === fetchPhotoLabel) {
		const socket = env.whatsappService.getSocket();
		if (socket?.profilePictureUrl) {
			try {
				const url = await socket.profilePictureUrl(contact.id, "image");
				if (url) {
					ctx.ui.notify(t("menu.contacts.contact.photoUrl", { url }), "info");
				} else {
					ctx.ui.notify(t("menu.contacts.contact.photoError"), "warning");
				}
			} catch {
				ctx.ui.notify(t("menu.contacts.contact.photoError"), "warning");
			}
		} else {
			ctx.ui.notify(t("menu.contacts.contact.photoError"), "warning");
		}
		await manageContactDetail(ctx, env, contact);
		return;
	}

	await manageContactsList(ctx, env);
}
