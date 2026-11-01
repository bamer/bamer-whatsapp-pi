import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
	mkdir: vi.fn(),
	writeFile: vi.fn()
}));

vi.mock('fs/promises', () => ({
	mkdir: f.mkdir,
	writeFile: f.writeFile,
	default: {}
}));

import { saveProfilePicture, showProfilePhoto } from '../../../src/ui/menu/photo.helper.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

describe('photo.helper', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		f.mkdir.mockResolvedValue(undefined);
		f.writeFile.mockResolvedValue(undefined);
	});

	it('saves the picture under whatsapp-medias/photos', async () => {
		const path = await saveProfilePicture('5511999998888@s.whatsapp.net', {
			base64: Buffer.from('img').toString('base64'),
			mimeType: 'image/jpeg'
		});

		expect(path).toContain('photos/5511999998888_s.whatsapp.net.jpg');
		expect(f.mkdir).toHaveBeenCalledWith(expect.stringContaining('photos'), { recursive: true });
		expect(f.writeFile).toHaveBeenCalledWith(path, expect.any(Buffer));
	});

	it('shows the real image in the transcript and reports the saved path', async () => {
		const env = makeEnv();
		(env.whatsappService.getContactsService() as any).fetchProfilePicture.mockResolvedValue({
			url: 'https://pic/a.jpg',
			base64: Buffer.from('img').toString('base64'),
			mimeType: 'image/jpeg'
		});
		const ctx = makeCtx();

		const result = await showProfilePhoto(ctx as any, env, 'a@s.whatsapp.net', 'Ana');

		expect(result?.url).toBe('https://pic/a.jpg');
		// Transcript entry (never an overlay: overlays corrupt the TUI).
		expect(env.pi.appendEntry).toHaveBeenCalledWith(
			'whatsapp-photo',
			expect.objectContaining({ mimeType: 'image/jpeg' })
		);
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('photos/a_s.whatsapp.net.jpg'),
			'info'
		);
	});

	it('shows a status while fetching and clears it afterwards', async () => {
		const env = makeEnv();
		let resolveFetch: (v: unknown) => void;
		(env.whatsappService.getContactsService() as any).fetchProfilePicture.mockReturnValue(
			new Promise((r) => { resolveFetch = r; })
		);
		const ctx = makeCtx();

		const pending = showProfilePhoto(ctx as any, env, 'a@s.whatsapp.net', 'Ana');
		await Promise.resolve();
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('wa-photo', expect.stringContaining('Ana'));

		resolveFetch!({
			url: 'https://pic/a.jpg',
			base64: Buffer.from('img').toString('base64'),
			mimeType: 'image/jpeg'
		});
		await pending;

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wa-photo', undefined);
	});

	it('warns when WhatsApp has no photo for the contact', async () => {
		const env = makeEnv();
		(env.whatsappService.getContactsService() as any).fetchProfilePicture.mockResolvedValue(null);
		const ctx = makeCtx();

		const result = await showProfilePhoto(ctx as any, env, 'a@s.whatsapp.net', 'Ana');

		expect(result).toBeNull();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('Ana'),
			'warning'
		);
		expect(env.pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});
});
