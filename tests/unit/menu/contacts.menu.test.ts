import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageContactsList } from '../../../src/ui/menu/contacts.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const BACK = () => t('menu.root.back');
const FILTER_PERSONAL = (n: number) => t('menu.contacts.filterPersonal', { count: n });
const FILTER_GROUP = (n: number) => t('menu.contacts.filterGroup', { count: n });
const FILTER_ALL = (n: number) => t('menu.contacts.filterAll', { count: n });

describe('contacts.menu', () => {
	let env: ReturnType<typeof makeEnv>;
	let contactsService: any;

	beforeEach(() => {
		resetI18n();
		env = makeEnv();
		contactsService = env.whatsappService.getContactsService();
	});

	it('notifies and returns to root when no contacts are synced', async () => {
		const ctx = makeCtx();

		await manageContactsList(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.contacts.empty'), 'info');
		expect(env.openRootMenu).toHaveBeenCalledTimes(1);
	});

	it('returns to root when Back is chosen at the filter step', async () => {
		(contactsService.getCount as any).mockReturnValue(5);
		(contactsService.getCountBySource as any)
			.mockReturnValueOnce(3) // personal
			.mockReturnValueOnce(2); // group
		const ctx = makeCtx({ selects: [BACK()] });

		await manageContactsList(ctx as any, env);

		expect(env.openRootMenu).toHaveBeenCalledTimes(1);
	});

	it('filters personal contacts then opens the detail of the selected one', async () => {
		const contact: any = {
			id: '5511999998888@s.whatsapp.net',
			name: 'Ana',
			phoneNumber: '+5511999998888'
		};
		(contactsService.getCount as any).mockReturnValue(5);
		(contactsService.getCountBySource as any)
			.mockReturnValue(3)
			.mockReturnValueOnce(2);
		(contactsService.getContactsBySource as any).mockReturnValue([contact]);
		const socket = { profilePictureUrl: vi.fn().mockResolvedValue('https://pic.example/a.jpg') };
		(env.whatsappService.getSocket as any).mockReturnValue(socket);
		const ctx = makeCtx({
			selects: [
				FILTER_PERSONAL(3),
				t('menu.contacts.contact.fetchPhoto'), // detail menu
				BACK(),                                // leave detail
			],
			customResult: '5511999998888@s.whatsapp.net'
		});

		await manageContactsList(ctx as any, env);

		expect(contactsService.getContactsBySource).toHaveBeenCalledWith('addressbook');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.contacts.contact.photoUrl', { url: 'https://pic.example/a.jpg' }), 'info'
		);
	});

	it('warns when a filter yields no contacts', async () => {
		(contactsService.getCount as any).mockReturnValue(5);
		(contactsService.getCountBySource as any)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(2);
		(contactsService.getContactsBySource as any).mockReturnValue([]);
		const ctx = makeCtx({ selects: [FILTER_PERSONAL(0)] });

		await manageContactsList(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.contacts.empty'), 'info');
	});

	it('returns to the list view when the searchable list is cancelled', async () => {
		const contact: any = { id: 'a@s.whatsapp.net', name: 'A' };
		(contactsService.getCount as any).mockReturnValue(1);
		(contactsService.getCountBySource as any)
			.mockReturnValueOnce(1)
			.mockReturnValueOnce(0);
		(contactsService.getAllContacts as any).mockReturnValue([contact]);
		const openRootMenu = vi.fn().mockResolvedValue(undefined);
		env.openRootMenu = openRootMenu;
		const ctx = makeCtx({
			selects: [FILTER_ALL(1)],
			customResult: null
		});

		await manageContactsList(ctx as any, env);

		// Cancel re-opens the list; second pass hits Back? No — cancel loops
		// back into manageContactsList which asks the filter again. Our ctx
		// returns the last option (Back) on subsequent selects -> root menu.
		expect(openRootMenu).toHaveBeenCalled();
	});

	describe('manageContactDetail — photo fetch branches', () => {
		async function drivePhoto(socket: any) {
			const contact: any = {
				id: '5511999998888@s.whatsapp.net',
				name: 'Ana',
				lid: '123456@lid',
				status: 'available'
			};
			(contactsService.getCount as any).mockReturnValue(1);
			(contactsService.getCountBySource as any)
				.mockReturnValue(1)
				.mockReturnValueOnce(0);
			(contactsService.getAllContacts as any).mockReturnValue([contact]);
			(env.whatsappService.getSocket as any).mockReturnValue(socket);
			const ctx = makeCtx({
				selects: [
					FILTER_ALL(1),
					t('menu.contacts.contact.fetchPhoto'),
					BACK(),
				],
				customResult: '5511999998888@s.whatsapp.net'
			});
			await manageContactsList(ctx as any, env);
			return { ctx, contact };
		}

		it('reports the photo URL on success', async () => {
			const socket = { profilePictureUrl: vi.fn().mockResolvedValue('https://ok') };
			const { ctx } = await drivePhoto(socket);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				t('menu.contacts.contact.photoUrl', { url: 'https://ok' }), 'info'
			);
		});

		it('warns when the URL is undefined', async () => {
			const socket = { profilePictureUrl: vi.fn().mockResolvedValue(undefined) };
			const { ctx } = await drivePhoto(socket);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				t('menu.contacts.contact.photoError'), 'warning'
			);
		});

		it('warns when the lookup throws', async () => {
			const socket = { profilePictureUrl: vi.fn().mockRejectedValue(new Error('nope')) };
			const { ctx } = await drivePhoto(socket);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				t('menu.contacts.contact.photoError'), 'warning'
			);
		});

		it('warns immediately when there is no socket', async () => {
			const { ctx } = await drivePhoto(undefined);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				t('menu.contacts.contact.photoError'), 'warning'
			);
		});

		it('lists name, LID and status in the detail header', async () => {
			const { ctx } = await drivePhoto(undefined);

			const headerNotify = ctx.ui.notify.mock.calls
				.map(([msg]) => String(msg))
				.find((m: string) => m.startsWith(t('menu.contacts.contact.title', { displayName: 'Ana' })));
			expect(headerNotify).toContain('ID: 5511999998888@s.whatsapp.net');
			expect(headerNotify).toContain('123456@lid');
		});
	});
});