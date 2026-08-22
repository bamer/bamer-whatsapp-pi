import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageAllowList } from '../../../src/ui/menu/allow-list.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const ADD = () => t('menu.allowed.addNumber');
const BACK = () => t('menu.root.back');

describe('allow-list.menu', () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		resetI18n();
		env = makeEnv();
	});

	it('adds a valid number and reports success', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['+33684136128'] });

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.addNumber).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowed.addedToAllowList', { number: '+33684136128' }), 'info'
		);
	});

	it('rejects an invalid number', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['hello'] });

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.addNumber).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.allowed.invalidNumber'), 'error');
	});

	it('returns to root on Back', async () => {
		const ctx = makeCtx({ selects: [BACK()] });

		await manageAllowList(ctx as any, env);

		expect(env.openRootMenu).toHaveBeenCalledTimes(1);
	});

	it('opens the contact detail and prints the number', async () => {
		const contact = { number: '+33684136128' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.allowed.contact.printNumber'),
				BACK(), // leave detail
				BACK(), // leave list
			]
		});

		await manageAllowList(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith('+33684136128', 'info');
	});

	it('sets a send number through the detail menu', async () => {
		const contact = { number: '+33684136128' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.allowed.contact.addNumber'), // add send-number option label
				'+5511999998888',
				BACK(),
				BACK(),
			],
			inputs: ['+5511999998888']
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.setContactSendNumber).toHaveBeenCalledWith(
			'+33684136128', '+5511999998888'
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowed.contact.numberAdded', { displayName: '+33684136128' }), 'info'
		);
	});

	it('removes a send number', async () => {
		const contact = { number: '+33684136128', sendNumber: '+5511999998888' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'+33684136128 (+5511999998888)',
				t('menu.allowed.contact.removeSendNumber'),
				BACK(),
				BACK(),
			]
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.removeContactSendNumber).toHaveBeenCalledWith('+33684136128');
	});

	it('adds an alias', async () => {
		const contact = { number: '+33684136128' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.allowed.contact.addAlias'),
				'Papa',
				BACK(),
				BACK(),
			],
			inputs: ['Papa']
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.setAllowedContactAlias).toHaveBeenCalledWith('+33684136128', 'Papa');
	});

	it('rejects an empty alias', async () => {
		const contact = { number: '+33684136128' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.allowed.contact.addAlias'),
				'',
				BACK(),
				BACK(),
			],
			inputs: ['']
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.setAllowedContactAlias).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.allowed.pleaseEnterAlias'), 'error');
	});

	it('removes an alias', async () => {
		const contact = { number: '+33684136128', name: 'Papa' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: [
				'Papa [+33684136128]',
				t('menu.allowed.contact.removeAlias'),
				BACK(),
				BACK(),
			]
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.removeAllowedContactAlias).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowed.aliasRemoved', { number: '+33684136128' }), 'info'
		);
	});

	it('removes the contact after confirmation', async () => {
		const contact = { number: '+33684136128' };
		(env.sessionManager.getAllowList as any).mockReturnValue([contact]);
		const ctx = makeCtx({
			selects: ['+33684136128', t('menu.allowed.contact.removeNumber')],
			confirms: [true]
		});

		await manageAllowList(ctx as any, env);

		expect(env.sessionManager.removeNumber).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.allowed.removed', { displayName: '+33684136128' }), 'info'
		);
	});
});

describe('allow-list.menu — remaining branches', () => {
    let env: ReturnType<typeof makeEnv>;

    beforeEach(() => {
        resetI18n();
        env = makeEnv();
    });

    it('re-prompts on an unknown list selection', async () => {
        (env.sessionManager.getAllowList as any).mockReturnValue([{ number: '+111' }]);
        const ctx = makeCtx({
            selects: ['ghost', 'Back']
        });

        await manageAllowList(ctx as any, env);

        // Unknown choice loops back into the list; second pass hits Back.
        expect(ctx.ui.select).toHaveBeenCalledTimes(2);
        expect(env.openRootMenu).toHaveBeenCalledTimes(1);
    });

    it('re-prompts when the send-number input is invalid', async () => {
        (env.sessionManager.getAllowList as any).mockReturnValue([{ number: '+111' }]);
        const ctx = makeCtx({
            selects: [
                '+111',
                t('menu.allowed.contact.addNumber'),
                'not-a-phone',
                t('menu.allowed.contact.back'),
                'Back'
            ],
            inputs: ['not-a-phone']
        });

        await manageAllowList(ctx as any, env);

        expect(env.sessionManager.setContactSendNumber).not.toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.allowed.invalidNumber'), 'error');
    });

    it('delegates History for a contact with a sendNumber option set', async () => {
        (env.sessionManager.getAllowList as any).mockReturnValue([
            { number: '+111', sendNumber: '+222' }
        ]);
        (env.recentsService.getConversationHistory as any).mockResolvedValue([]);
        const ctx = makeCtx({
            selects: [
                '+111 (+222)',
                t('menu.allowed.contact.history'),
                t('menu.allowed.contact.back'),
                'Back'
            ]
        });

        await manageAllowList(ctx as any, env);

        expect(env.recentsService.getConversationHistory).toHaveBeenCalledWith('+111');
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('history'), 'info'
        );
    });

    it('keeps the contact when removal is declined', async () => {
        (env.sessionManager.getAllowList as any).mockReturnValue([{ number: '+111' }]);
        const ctx = makeCtx({
            selects: ['+111', t('menu.allowed.contact.removeNumber')],
            confirms: [false]
        });

        await manageAllowList(ctx as any, env);

        expect(env.sessionManager.removeNumber).not.toHaveBeenCalled();
        expect(ctx.ui.notify).not.toHaveBeenCalledWith(
            t('menu.allowed.removed', { displayName: '+111' }), 'info'
        );
    });
});
