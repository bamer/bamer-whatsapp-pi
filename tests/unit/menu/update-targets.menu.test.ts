import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageUpdateList, manageUpdateTarget } from '../../../src/ui/menu/update-targets.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const ADD = () => t('menu.updateTargets.addNumber');
const BACK = () => t('menu.root.back');

describe('update-targets.menu', () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		resetI18n();
		env = makeEnv();
	});

	it('adds a valid number and reports success', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['+33684136128'] });

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.addUpdateNumber).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.updateTargets.added', { number: '+33684136128' }), 'info');
	});

	it('rejects an invalid number without saving', async () => {
		const ctx = makeCtx({ selects: [ADD()], inputs: ['not-a-number'] });

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.addUpdateNumber).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.updateTargets.invalidNumber'), 'error');
	});

	it('opens the target detail menu for a listed contact and prints its number', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128' }]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',                    // pick the target
				t('menu.updateTargets.target.printNumber'),
				BACK(),                            // leave detail
				BACK(),                            // leave list
			]
		});

		await manageUpdateList(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith('+33684136128', 'info');
		expect(env.openRootMenu).toHaveBeenCalled();
	});

	it('adds an alias through the detail menu', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128' }]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.updateTargets.target.addAlias'),
				'Patrice',
				BACK(),
				BACK(),
			],
			inputs: ['Patrice']
		});

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.addUpdateNumber).toHaveBeenCalledWith('+33684136128', 'Patrice');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.updateTargets.aliasAdded', { number: '+33684136128' }), 'info'
		);
	});

	it('rejects an empty alias without saving', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128' }]);
		const ctx = makeCtx({
			selects: [
				'+33684136128',
				t('menu.updateTargets.target.addAlias'),
				'   ',
				BACK(),
				BACK(),
			],
			inputs: ['   ']
		});

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.addUpdateNumber).not.toHaveBeenCalledWith('+33684136128', 'Patrice');
		expect(env.sessionManager.addUpdateNumber).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.updateTargets.pleaseEnterAlias'), 'error');
	});

	it('removes an alias by re-adding the bare number', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128', name: 'Patrice' }]);
		const ctx = makeCtx({
			selects: [
				'Patrice [+33684136128]',
				t('menu.updateTargets.target.removeAlias'),
				BACK(),
				BACK(),
			]
		});

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.addUpdateNumber).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.updateTargets.aliasRemoved', { number: '+33684136128' }), 'info'
		);
	});

	it('removes the target after confirmation', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128' }]);
		const ctx = makeCtx({
			selects: ['+33684136128', t('menu.updateTargets.target.removeNumber')],
			confirms: [true]
		});

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.removeUpdateNumber).toHaveBeenCalledWith('+33684136128');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.updateTargets.removed', { displayName: '+33684136128' }), 'info'
		);
	});

	it('keeps the target when removal is cancelled', async () => {
		(env.sessionManager.getUpdateList as any).mockReturnValue([{ number: '+33684136128' }]);
		const ctx = makeCtx({
			selects: ['+33684136128', t('menu.updateTargets.target.removeNumber')],
			confirms: [false]
		});

		await manageUpdateList(ctx as any, env);

		expect(env.sessionManager.removeUpdateNumber).not.toHaveBeenCalled();
	});

	it('returns to the root menu on Back', async () => {
		const ctx = makeCtx({ selects: [BACK()] });

		await manageUpdateList(ctx as any, env);

		expect(env.openRootMenu).toHaveBeenCalledTimes(1);
	});

	it('manageUpdateTarget falls back to the list on unknown choice', async () => {
		const ctx = makeCtx({ selects: [undefined as any] });

		await manageUpdateTarget(ctx as any, env, { number: '+111' });

		// Falls through to manageUpdateList which then hits Back (default = last option).
		expect(ctx.ui.select).toHaveBeenCalled();
	});
});
