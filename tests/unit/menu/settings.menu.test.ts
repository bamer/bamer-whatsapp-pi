import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import { manageSettings } from '../../../src/ui/menu/settings.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const BACK = () => t('menu.settings.back');

describe('settings.menu', () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		resetI18n();
		env = makeEnv();
		// Default labels for a fresh default config.
	});

	it('toggles brand visibility and reports the new value', async () => {
		const ctx = makeCtx({ selects: [t('menu.settings.brandVisibilityYes')] });

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setBrandVisibility).toHaveBeenCalledWith(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.brandVisibilitySet', { value: 'No' }), 'info'
		);
		expect(ctx.ui.select).toHaveBeenCalledTimes(2); // settings shown again after change
	});

	it('toggles auto-connect', async () => {
		const ctx = makeCtx({ selects: [t('menu.settings.autoConnectNo')] });

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAutoConnect).toHaveBeenCalledWith(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.autoConnectSet', { value: 'Yes' }), 'info'
		);
	});

	it('sets the assistant name', async () => {
		const ctx = makeCtx({
			selects: [`${t('menu.settings.assistantName')}: Agent Pi`],
			inputs: ['Carl']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAssistantName).toHaveBeenCalledWith('Carl');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.assistantNameSet', { value: 'Carl' }), 'info'
		);
	});

	it('ignores an empty assistant name', async () => {
		const ctx = makeCtx({
			selects: [`${t('menu.settings.assistantName')}: Agent Pi`],
			inputs: ['   ']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAssistantName).not.toHaveBeenCalled();
	});

	it('sets the agent signature', async () => {
		const ctx = makeCtx({
			selects: [`${t('menu.settings.agentSignature')}: π`],
			inputs: ['★']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAgentSignature).toHaveBeenCalledWith('★');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.agentSignatureSet', { value: '★' }), 'info'
		);
	});

	it('clears the agent signature with an empty input', async () => {
		const ctx = makeCtx({
			selects: [`${t('menu.settings.agentSignature')}: π`],
			inputs: ['']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAgentSignature).toHaveBeenCalledWith('');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.agentSignatureSet', { value: '(none)' }), 'info'
		);
	});

	it('keeps the current signature on cancel (null)', async () => {
		const ctx = makeCtx({
			selects: [`${t('menu.settings.agentSignature')}: π`],
			inputs: [undefined]
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setAgentSignature).not.toHaveBeenCalled();
	});

	it.each([
		['5', 5],
		['0', 0],
		['99', 20],   // clamped to max
	])('log max size: %s -> clamped/parsed %s', async (raw, expected) => {
		const ctx = makeCtx({
			selects: [t('menu.settings.logMaxSize', { value: 5 })],
			inputs: [raw]
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setLogMaxSizeMB).toHaveBeenCalledWith(expected);
	});

	it('rejects a non-numeric log size', async () => {
		const ctx = makeCtx({
			selects: [t('menu.settings.logMaxSize', { value: 5 })],
			inputs: ['abc']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setLogMaxSizeMB).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.settings.logMaxSizePrompt'), 'error');
	});

	it('sets log retention within bounds', async () => {
		const ctx = makeCtx({
			selects: [t('menu.settings.logRetention', { value: 7 })],
			inputs: ['400']
		});

		await manageSettings(ctx as any, env);

		expect(env.sessionManager.setLogRetentionDays).toHaveBeenCalledWith(365); // clamped
	});

	it('fetches contacts from groups when the socket supports it', async () => {
		const cs: any = (env.whatsappService.getContactsService as any)();
		cs.fetchContactsFromGroups.mockResolvedValue({ groups: 3, contacts: 25 });
		(env.whatsappService.getSocket as any).mockReturnValue({ groupFetchAllParticipating: vi.fn() });
		const ctx = makeCtx({ selects: [t('menu.settings.fetchContacts')] });

		await manageSettings(ctx as any, env);

		expect(cs.fetchContactsFromGroups).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.fetchContactsResult', { groups: 3, contacts: 25 }), 'info'
		);
	});

	it('warns when fetching without a socket', async () => {
		const ctx = makeCtx({ selects: [t('menu.settings.fetchContacts')] });

		await manageSettings(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(t('menu.settings.fetchContactsNoSocket'), 'error');
	});

	it('reports fetch errors', async () => {
		const cs: any = (env.whatsappService.getContactsService as any)();
		cs.fetchContactsFromGroups.mockRejectedValue(new Error('boom'));
		(env.whatsappService.getSocket as any).mockReturnValue({ groupFetchAllParticipating: vi.fn() });
		const ctx = makeCtx({ selects: [t('menu.settings.fetchContacts')] });

		await manageSettings(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.fetchContactsError', { error: 'Error: boom' }), 'error'
		);
	});

	it('reclassifies contacts and reports the counts', async () => {
		const cs: any = (env.whatsappService.getContactsService as any)();
		cs.reclassifyContacts.mockReturnValue({ upgraded: 12, total: 500 });
		const ctx = makeCtx({ selects: [t('menu.settings.reclassifyContacts')] });

		await manageSettings(ctx as any, env);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			t('menu.settings.reclassifyResult', { upgraded: 12, total: 500 }), 'info'
		);
	});

	it('returns to the root menu on Back', async () => {
		const ctx = makeCtx({ selects: [BACK()] });

		await manageSettings(ctx as any, env);

		expect(env.openRootMenu).toHaveBeenCalledTimes(1);
	});
});
