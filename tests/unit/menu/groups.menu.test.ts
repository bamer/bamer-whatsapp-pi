import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageAllowedGroups } from '../../../src/ui/menu/groups.menu.ts';
import { makeCtx, makeEnv, type SelectChoice } from './menu-test-utils.ts';

const ADD = () => t('menu.allowedGroups.addGroup');
const BACK = () => t('menu.root.back');

describe('groups.menu', () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		resetI18n();
		env = makeEnv();
	});

	it('adds a valid group JID and reports success', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['120363409409770410@g.us'] });

		await manageAllowedGroups(ctx as any, env);

		expect(env.sessionManager.addAllowedGroup).toHaveBeenCalledWith('120363409409770410@g.us');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowedGroups.addedToAllowList', { groupJid: '120363409409770410@g.us' }), 'info'
		);
	});

	it('rejects a non-group JID without saving', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['+33684136128'] });

		await manageAllowedGroups(ctx as any, env);

		expect(env.sessionManager.addAllowedGroup).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.allowedGroups.invalidGroup'), 'error');
	});

	it('sends a message to the group through the prompted flow with π suffix', async () => {
		const group = { number: '120363409409770410@g.us', name: 'Family' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		const ctx = makeCtx({
			selects: [
				'Family (120363409409770410@g.us)',
				t('menu.allowedGroups.group.sendMessage'),
				'Hello family',
				BACK(),
				BACK(),
			],
			inputs: ['Hello family']
		});

		await manageAllowedGroups(ctx as any, env);

		expect(env.whatsappService.sendMenuMessage).toHaveBeenCalledWith(
			'120363409409770410@g.us',
			'Hello family π'
		);
		expect(env.recentsService.recordMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				senderNumber: '120363409409770410@g.us',
				text: 'Hello family π',
				direction: 'outgoing'
			})
		);
	});

	it('reports the send failure to the user', async () => {
		const group = { number: '120363409409770410@g.us' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		(env.whatsappService.sendMenuMessage as any).mockResolvedValue({
			success: false, error: 'socket gone'
		});
		const ctx = makeCtx({
			selects: [
				'120363409409770410@g.us',
				t('menu.allowedGroups.group.sendMessage'),
				'Hello',
				BACK(),
				BACK(),
			],
			inputs: ['Hello']
		});

		await manageAllowedGroups(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('socket gone'), 'error'
		);
	});

	it('delegates History to the recents module for the group JID', async () => {
		const group = { number: '120363409409770410@g.us', name: 'Family' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);

		const historySpy = vi.fn().mockResolvedValue(undefined);
		// Spy on the shared history entry point via the recents module.
		const recentsModule = await import('../../../src/ui/menu/recents.menu.ts');
		const orig = recentsModule.showConversationHistoryForContact;
		const moduleMock = vi.spyOn(recentsModule, 'showConversationHistoryForContact')
			.mockImplementation(historySpy as any);

		const ctx = makeCtx({
			selects: [
				'Family (120363409409770410@g.us)',
				t('menu.allowedGroups.group.history'),
				BACK(),
				BACK(),
			] as SelectChoice[]
		});

		try {
			await manageAllowedGroups(ctx as any, env);
		} finally {
			moduleMock.mockRestore();
		}

		expect(historySpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ sessionManager: env.sessionManager }),
				'120363409409770410@g.us',
				'Family (120363409409770410@g.us)',
			);
	});

	it('prints the group JID', async () => {
		const group = { number: '120363409409770410@g.us' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		const ctx = makeCtx({
			selects: [
				'120363409409770410@g.us',
				t('menu.allowedGroups.group.printGroup'),
				BACK(),
				BACK(),
			]
		});

		await manageAllowedGroups(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith('120363409409770410@g.us', 'info');
	});

	it('adds an alias to the group', async () => {
		const group = { number: '120363409409770410@g.us' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		const ctx = makeCtx({
			selects: [
				'120363409409770410@g.us',
				t('menu.allowedGroups.group.addAlias'),
				'Boutique',
				BACK(),
				BACK(),
			],
			inputs: ['Boutique']
		});

		await manageAllowedGroups(ctx as any, env);

		expect(env.sessionManager.setAllowedGroupAlias).toHaveBeenCalledWith(
			'120363409409770410@g.us', 'Boutique'
		);
	});

	it('removes an alias from the group', async () => {
		const group = { number: '120363409409770410@g.us', name: 'Boutique' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		const ctx = makeCtx({
			selects: [
				'Boutique (120363409409770410@g.us)',
				t('menu.allowedGroups.group.removeAlias'),
				BACK(),
				BACK(),
			]
		});

		await manageAllowedGroups(ctx as any, env);

		expect(env.sessionManager.removeAllowedGroupAlias).toHaveBeenCalledWith(
			'120363409409770410@g.us'
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowedGroups.aliasRemoved', { groupJid: '120363409409770410@g.us' }),
			'info'
		);
	});

	it('removes the group after confirmation', async () => {
		const group = { number: '120363409409770410@g.us' };
		(env.sessionManager.getAllowedGroups as any).mockReturnValue([group]);
		const ctx = makeCtx({
			selects: ['120363409409770410@g.us', t('menu.allowedGroups.group.removeGroup')],
			confirms: [true]
		});

		await manageAllowedGroups(ctx as any, env);

		expect(env.sessionManager.removeAllowedGroup).toHaveBeenCalledWith('120363409409770410@g.us');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowedGroups.removed', { displayName: '120363409409770410@g.us' }), 'info'
		);
	});
});
