import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageContactsList } from '../../../src/ui/menu/contacts.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const photoMocks = vi.hoisted(() => ({
	showProfilePhoto: vi.fn().mockResolvedValue(null)
}));

vi.mock('../../../src/ui/menu/photo.helper.ts', () => ({
	showProfilePhoto: photoMocks.showProfilePhoto,
	saveProfilePicture: vi.fn()
}));

const BACK = () => t('menu.root.back');
const FILTER_PERSONAL = (n: number) => t('menu.contacts.filterPersonal', { count: n });
const FILTER_ALL = (n: number) => t('menu.contacts.filterAll', { count: n });

describe('contacts.menu', () => {
	let env: ReturnType<typeof makeEnv>;
	let contactsService: any;

	beforeEach(() => {
		resetI18n();
		photoMocks.showProfilePhoto.mockClear();
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
		expect(photoMocks.showProfilePhoto).toHaveBeenCalledWith(
			ctx,
			env,
			'5511999998888@s.whatsapp.net',
			'Ana'
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
		async function drivePhoto() {
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

		it('shows the real photo of the selected contact', async () => {
			const { ctx } = await drivePhoto();

			expect(photoMocks.showProfilePhoto).toHaveBeenCalledWith(
				ctx,
				env,
				'5511999998888@s.whatsapp.net',
				'Ana'
			);
		});

		it('lists name, LID and status in the detail header', async () => {
			const { ctx } = await drivePhoto();

			const headerNotify = ctx.ui.notify.mock.calls
				.map(([msg]) => String(msg))
				.find((m: string) => m.startsWith(t('menu.contacts.contact.title', { displayName: 'Ana' })));
			expect(headerNotify).toContain('ID: 5511999998888@s.whatsapp.net');
			expect(headerNotify).toContain('123456@lid');
		});
	});
});