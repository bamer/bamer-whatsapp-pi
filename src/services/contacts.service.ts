import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileLog } from './storage-path.js';

export interface SyncedContact {
	id: string;
	lid?: string;
	phoneNumber?: string;
	name?: string;
	notify?: string;
	status?: string;
	imgUrl?: string | null;
}

export class ContactsService {
	private contacts = new Map<string, SyncedContact>();
	private dirty = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly contactsPath: string) {}

	/** Attach event listeners to a Baileys socket. */
	attach(
		socket: {
			ev: {
				on(event: 'contacts.upsert', handler: (contacts: any[]) => void | Promise<void>): void;
				on(event: 'contacts.update', handler: (contacts: any[]) => void | Promise<void>): void;
			};
			profilePictureUrl?(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>;
		},
	) {
		socket.ev.on('contacts.upsert', (contacts) => {
			for (const c of contacts) {
				if (!c?.id) continue;
				const existing = this.contacts.get(c.id) ?? {};
				this.contacts.set(c.id, { ...existing, ...c });
			}
			fileLog(`[Contacts] upsert: ${contacts.length} contacts (total: ${this.contacts.size})`);
			this.scheduleSave();
		});

		socket.ev.on('contacts.update', (contacts) => {
			for (const c of contacts) {
				if (!c?.id) continue;
				const existing = this.contacts.get(c.id) ?? {};
				this.contacts.set(c.id, { ...existing, ...c });
			}
			fileLog(`[Contacts] update: ${contacts.length} contacts (total: ${this.contacts.size})`);
			this.scheduleSave();
		});
	}

	/** Load contacts from disk. */
	async load(): Promise<void> {
		try {
			const data = await readFile(this.contactsPath, 'utf-8');
			const parsed = JSON.parse(data) as Record<string, SyncedContact>;
			this.contacts = new Map(Object.entries(parsed));
			fileLog(`[Contacts] loaded ${this.contacts.size} contacts from disk`);
		} catch {
			fileLog('[Contacts] no contacts file yet — starting fresh');
		}
	}

	/** Get all synced contacts, sorted by name. */
	getAllContacts(): SyncedContact[] {
		return [...this.contacts.values()].sort((a, b) => {
			const nameA = a.name || a.notify || a.id;
			const nameB = b.name || b.notify || b.id;
			return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
		});
	}

	/** Get a single contact by JID. */
	getContact(jid: string): SyncedContact | undefined {
		return this.contacts.get(jid);
	}

	/** Get count. */
	getCount(): number {
		return this.contacts.size;
	}

	/** Fetch profile picture URL for a contact. */
	async getProfilePictureUrl(
		socket: { profilePictureUrl?(jid: string, type?: 'preview' | 'image'): Promise<string | undefined> },
		jid: string,
	): Promise<string | undefined> {
		try {
			return await socket.profilePictureUrl?.(jid, 'image');
		} catch {
			return undefined;
		}
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 2000);
	}

	private async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			const dir = join(this.contactsPath, '..');
			await mkdir(dir, { recursive: true });
			const obj: Record<string, SyncedContact> = {};
			for (const [jid, contact] of this.contacts) {
				obj[jid] = contact;
			}
			await writeFile(this.contactsPath, JSON.stringify(obj, null, 2), 'utf-8');
			fileLog(`[Contacts] saved ${this.contacts.size} contacts to disk`);
		} catch (err) {
			fileLog(`[Contacts] save error: ${err}`);
		}
	}
}
