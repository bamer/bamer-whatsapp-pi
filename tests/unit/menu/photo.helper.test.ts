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

	it('shows the real image and reports the saved path', async () => {
		const env = makeEnv();
		(env.whatsappService.getContactsService() as any).fetchProfilePicture.mockResolvedValue({
			url: 'https://pic/a.jpg',
			base64: Buffer.from('img').toString('base64'),
			mimeType: 'image/jpeg'
		});
		const ctx = makeCtx();

		const result = await showProfilePhoto(ctx as any, env, 'a@s.whatsapp.net', 'Ana');

		expect(result?.url).toBe('https://pic/a.jpg');
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('photos/a_s.whatsapp.net.jpg'),
			'info'
		);
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
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});
});
