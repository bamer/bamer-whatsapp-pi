import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    fileLog: vi.fn()
}));

vi.mock('fs/promises', () => ({
    readFile: f.readFile,
    writeFile: f.writeFile,
    mkdir: f.mkdir,
    default: {}
}));

vi.mock('../../src/services/storage-path.ts', () => ({
    fileLog: f.fileLog
}));

import { ContactsService, type SyncedContact } from '../../src/services/contacts.service.ts';

const CONTACTS_PATH = '/fake/root/contacts.json';

const makeSocket = () => {
    const handlers = new Map<string, (payload: any) => void | Promise<void>>();
    return {
        handlers,
        ev: {
            on: vi.fn((event: string, handler: (payload: any) => void | Promise<void>) => {
                handlers.set(event, handler);
            })
        },
        profilePictureUrl: vi.fn().mockResolvedValue('https://example.com/pic.jpg')
    };
};

const flushSave = () => new Promise((resolve) => setTimeout(resolve, 2100));

describe('ContactsService', () => {
    let service: ContactsService;

    beforeEach(() => {
        vi.clearAllMocks();
        f.readFile.mockRejectedValue(new Error('not found'));
        f.writeFile.mockResolvedValue(undefined);
        f.mkdir.mockResolvedValue(undefined);
        service = new ContactsService(CONTACTS_PATH);
    });

    describe('load', () => {
        it('starts fresh when no contacts file exists', async () => {
            await service.load();

            expect(service.getCount()).toBe(0);
            expect(f.fileLog).toHaveBeenCalledWith('[Contacts] no contacts file yet — starting fresh');
        });

        it('loads contacts from disk', async () => {
            f.readFile.mockResolvedValue(JSON.stringify({
                '5511999998888@s.whatsapp.net': { id: '5511999998888@s.whatsapp.net', name: 'Ana', source: 'addressbook' }
            }));

            await service.load();

            expect(service.getCount()).toBe(1);
            expect(service.getContact('5511999998888@s.whatsapp.net')?.name).toBe('Ana');
        });

        it('tolerates malformed JSON', async () => {
            f.readFile.mockResolvedValue('{not json');

            await expect(service.load()).resolves.toBeUndefined();
            expect(service.getCount()).toBe(0);
        });
    });

    describe('attach — socket event handlers', () => {
        it('registers the three event listeners', () => {
            const socket = makeSocket();
            service.attach(socket as any);

            expect(socket.ev.on).toHaveBeenCalledTimes(3);
            expect(socket.handlers.has('contacts.upsert')).toBe(true);
            expect(socket.handlers.has('contacts.update')).toBe(true);
            expect(socket.handlers.has('messaging-history.set')).toBe(true);
        });

        it('upsert adds contacts with a name as addressbook source', async () => {
            const socket = makeSocket();
            service.attach(socket as any);

            await socket.handlers.get('contacts.upsert')!([
                { id: 'a@s.whatsapp.net', name: 'Ana' },
                { id: null }, // skipped: no id
            ]);

            expect(service.getContact('a@s.whatsapp.net')?.source).toBe('addressbook');
            expect(service.getCount()).toBe(1);
        });

        it('upsert without name keeps existing group source', async () => {
            service.load = vi.fn().mockResolvedValue(undefined);
            // Seed a group contact through fetchContactsFromGroups.
            const groupSocket = {
                groupFetchAllParticipating: vi.fn().mockResolvedValue({
                    'g@g.us': { id: 'g@g.us', subject: 'G', participants: [{ id: 'p@lid' }] }
                })
            };
            await service.fetchContactsFromGroups(groupSocket as any);

            const socket = makeSocket();
            service.attach(socket as any);
            await socket.handlers.get('contacts.upsert')!([{ id: 'p@lid' }]);

            expect(service.getContact('p@lid')?.source).toBe('group');
        });

        it('messaging-history.set marks contacts as addressbook and ignores empty payloads', async () => {
            const socket = makeSocket();
            service.attach(socket as any);

            await socket.handlers.get('messaging-history.set')!({ contacts: undefined });
            await socket.handlers.get('messaging-history.set')!({ contacts: [] });
            await socket.handlers.get('messaging-history.set')!({
                contacts: [{ id: 'h@s.whatsapp.net', name: 'History Person' }, { id: undefined }]
            });

            expect(service.getContact('h@s.whatsapp.net')?.source).toBe('addressbook');
            expect(service.getCount()).toBe(1);
        });

        it('contacts.update upgrades source when name appears', async () => {
            const socket = makeSocket();
            service.attach(socket as any);

            await socket.handlers.get('contacts.upsert')!([{ id: 'x@lid' }]);
            await socket.handlers.get('contacts.update')!([{ id: 'x@lid', notify: 'Xavier' }]);

            expect(service.getContact('x@lid')?.notify).toBe('Xavier');
            expect(service.getContact('x@lid')?.source).toBe('addressbook');
        });
    });

    describe('getAllContacts / getContactsBySource', () => {
        it('sorts contacts by name (name > notify > id), case-insensitive', async () => {
            const groupSocket = {
                groupFetchAllParticipating: vi.fn().mockResolvedValue({
                    'g@g.us': {
                        id: 'g@g.us', subject: 'G',
                        participants: [{ id: 'zeta@lid' }, { id: 'alpha@lid', phoneNumber: '+111' }]
                    }
                })
            };
            await service.fetchContactsFromGroups(groupSocket as any);

            const socket = makeSocket();
            service.attach(socket as any);
            await socket.handlers.get('contacts.upsert')!([
                { id: 'm@s.whatsapp.net', notify: 'mario' },
                { id: 'b@s.whatsapp.net', name: 'Beatrice' },
            ]);

            const all = service.getAllContacts();
            expect(all.map((c) => c.name || c.notify || c.id)).toEqual([
                'alpha@lid', 'Beatrice', 'mario', 'zeta@lid'
            ]);

            expect(service.getContactsBySource('addressbook').map((c) => c.id)).toEqual([
                'b@s.whatsapp.net', 'm@s.whatsapp.net'
            ]);
            expect(service.getContactsBySource('group').map((c) => c.id)).toEqual([
                'alpha@lid', 'zeta@lid'
            ]);
            expect(service.getCountBySource('addressbook')).toBe(2);
            expect(service.getCountBySource('group')).toBe(2);
        });
    });

    describe('reclassifyContacts', () => {
        it('upgrades named group contacts to addressbook and reports counts', async () => {
            // Seed stale state from disk: named contact still tagged as 'group'.
            f.readFile.mockResolvedValue(JSON.stringify({
                'p1@lid': { id: 'p1@lid', source: 'group' },
                'p2@lid': { id: 'p2@lid', name: 'P Two', source: 'group' },
                'p3@lid': { id: 'p3@lid', notify: 'P Three', source: 'addressbook' }
            }));
            await service.load();

            const result = service.reclassifyContacts();

            expect(result).toEqual({ upgraded: 1, total: 3 });
            expect(service.getContact('p2@lid')?.source).toBe('addressbook');
            expect(service.getContact('p1@lid')?.source).toBe('group');
            // Already addressbook: not double-counted.
            expect(service.getContact('p3@lid')?.source).toBe('addressbook');
        });
    });

    describe('fetchContactsFromGroups', () => {
        it('adds new participants as group contacts and backfills phone numbers', async () => {
            const socket = {
                groupFetchAllParticipating: vi.fn().mockResolvedValue({
                    'g1@g.us': {
                        id: 'g1@g.us', subject: 'One',
                        participants: [{ id: 'new@lid', phoneNumber: '+331' }, { id: 'skip-me' }, null]
                    },
                    'g2@g.us': {
                        id: 'g2@g.us', subject: 'Two',
                        participants: [{ id: 'new@lid', phoneNumber: '+339' }] // duplicate: ignored
                    }
                })
            };

            const result = await service.fetchContactsFromGroups(socket as any);

            expect(result).toEqual({ groups: 2, contacts: 2 });
            expect(service.getContact('new@lid')).toEqual({
                id: 'new@lid',
                phoneNumber: '+331',
                source: 'group'
            });
            expect(service.getContact('skip-me')).toEqual({
                id: 'skip-me',
                phoneNumber: undefined,
                source: 'group'
            });
        });

        it('backfills the phone number of an existing contact that has none', async () => {
            const first = {
                groupFetchAllParticipating: vi.fn().mockResolvedValue({
                    'g@g.us': { id: 'g@g.us', subject: 'G', participants: [{ id: 'p@lid' }] }
                })
            };
            await service.fetchContactsFromGroups(first as any);

            const second = {
                groupFetchAllParticipating: vi.fn().mockResolvedValue({
                    'g@g.us': { id: 'g@g.us', subject: 'G', participants: [{ id: 'p@lid', phoneNumber: '+972' }] }
                })
            };
            const result = await service.fetchContactsFromGroups(second as any);

            expect(result.contacts).toBe(0);
            expect(service.getContact('p@lid')?.phoneNumber).toBe('+972');
        });
    });

    describe('getProfilePictureUrl', () => {
        it('returns the URL when the socket resolves', async () => {
            const socket = { profilePictureUrl: vi.fn().mockResolvedValue('https://pic') };

            await expect(service.getProfilePictureUrl(socket as any, 'a@lid')).resolves.toBe('https://pic');
            expect(socket.profilePictureUrl).toHaveBeenCalledWith('a@lid', 'image');
        });

        it('returns undefined when the socket rejects or lacks the method', async () => {
            const failing = { profilePictureUrl: vi.fn().mockRejectedValue(new Error('no pic')) };
            await expect(service.getProfilePictureUrl(failing as any, 'a@lid')).resolves.toBeUndefined();
            await expect(service.getProfilePictureUrl({} as any, 'a@lid')).resolves.toBeUndefined();
        });
    });

    describe('persistence (debounced save)', () => {
        it('saves contacts to disk after the debounce window', async () => {
            vi.useFakeTimers();
            const socket = makeSocket();
            service.attach(socket as any);
            await socket.handlers.get('contacts.upsert')!([{ id: 'a@s.whatsapp.net', name: 'Ana' }]);

            // Not saved yet (2s debounce).
            expect(f.writeFile).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2100);

            expect(f.mkdir).toHaveBeenCalledWith('/fake/root', { recursive: true });
            expect(f.writeFile).toHaveBeenCalledWith(
                CONTACTS_PATH,
                expect.stringContaining('"a@s.whatsapp.net"'),
                'utf-8'
            );
            vi.useRealTimers();
        });

        it('coalesces rapid updates into a single save', async () => {
            vi.useFakeTimers();
            const socket = makeSocket();
            service.attach(socket as any);
            await socket.handlers.get('contacts.upsert')!([{ id: 'a@s.whatsapp.net', name: 'A' }]);
            await socket.handlers.get('contacts.upsert')!([{ id: 'b@s.whatsapp.net', name: 'B' }]);

            await vi.advanceTimersByTimeAsync(2100);

            expect(f.writeFile).toHaveBeenCalledTimes(1);
            const saved = JSON.parse(f.writeFile.mock.calls[0][1]);
            expect(Object.keys(saved)).toHaveLength(2);
            vi.useRealTimers();
        });

        it('swallows save errors via fileLog', async () => {
            vi.useFakeTimers();
            f.writeFile.mockRejectedValue(new Error('disk full'));
            const socket = makeSocket();
            service.attach(socket as any);
            await socket.handlers.get('contacts.upsert')!([{ id: 'a@s.whatsapp.net' }]);

            await vi.advanceTimersByTimeAsync(2100);

            expect(f.fileLog).toHaveBeenCalledWith(expect.stringContaining('save error'));
            vi.useRealTimers();
        });
    });
});
