import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { IncomingMediaService } from '../../src/services/incoming-media.service.ts';

// Mirrors createStoragePaths().mediaDir (storage-path.ts) with the mocked homedir.
const HOME = '/home/testuser';
const MEDIA_DIR = join(HOME, '.pi', 'agent', 'extensions', 'whatsapp-pi', 'whatsapp-medias');

vi.mock('os', () => ({
    homedir: () => HOME,
    default: { homedir: () => HOME }
}));

const mocks = vi.hoisted(() => ({
    downloadContentFromMessage: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    pdfParse: vi.fn()
}));

vi.mock('baileys', () => ({
    downloadContentFromMessage: mocks.downloadContentFromMessage
}));

vi.mock('node:fs/promises', () => ({
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile
}));

vi.mock('@llamaindex/liteparse', () => ({
    LiteParse: class {
        constructor() {}
        parse = mocks.pdfParse;
    }
}));

const streamFrom = async function* (chunks: Buffer[]) {
    for (const chunk of chunks) {
        yield chunk;
    }
};

describe('IncomingMediaService', () => {
    const audioService = {
        transcribe: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        audioService.transcribe.mockResolvedValue('audio text');
        mocks.downloadContentFromMessage.mockResolvedValue(streamFrom([Buffer.from('media')]));
        mocks.pdfParse.mockResolvedValue({ text: 'PDF body text' });
        vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    });

    it('passes through non-media resolved content', async () => {
        const service = new IncomingMediaService(audioService as any);

        await expect(service.process({ kind: 'text', text: 'hello' }, 'Ana')).resolves.toEqual({
            text: 'hello'
        });
    });

    it('transcribes audio messages', async () => {
        const service = new IncomingMediaService(audioService as any);
        const audioMessage = { seconds: 2 };

        await expect(service.process({ kind: 'audio', text: '[Audio Message]', audioMessage }, 'Ana')).resolves.toEqual({
            text: '🎤 audio text'
        });

        expect(audioService.transcribe).toHaveBeenCalledWith(audioMessage);
        expect(console.log).not.toHaveBeenCalled();
    });

    it('downloads images and normalizes image/jpg MIME type', async () => {
        const service = new IncomingMediaService(audioService as any);

        const result = await service.process({
            kind: 'image',
            text: 'caption',
            imageMessage: { mimetype: 'image/jpg; charset=utf-8' }
        }, 'Ana');

        expect(mocks.downloadContentFromMessage).toHaveBeenCalledWith(
            { mimetype: 'image/jpg; charset=utf-8' },
            'image'
        );
        expect(result).toEqual({
            text: 'caption',
            imageBuffer: Buffer.from('media'),
            imageMimeType: 'image/jpeg',
            savedMediaPath: join(MEDIA_DIR, 'image', 'image_1234567890.jpg')
        });
    });

    it('returns a readable fallback when image download fails', async () => {
        const service = new IncomingMediaService(audioService as any);
        mocks.downloadContentFromMessage.mockRejectedValue(new Error('download failed'));

        await expect(service.process({
            kind: 'image',
            text: '[Image]',
            imageMessage: {}
        }, 'Ana')).resolves.toEqual({
            text: '[Image (download failed)]'
        });
    });

    it('saves pdf documents and includes bounded extracted text preview', async () => {
        const service = new IncomingMediaService(audioService as any);
        const longText = `First line\n${'A'.repeat(1800)}`;
        mocks.pdfParse.mockResolvedValueOnce({ text: longText });

        const result = await service.process({
            kind: 'document',
            text: '[Document]',
            documentMessage: {
                fileName: 'contract.pdf',
                mimetype: 'application/pdf',
                fileLength: 2 * 1024 * 1024,
                caption: 'Read this'
            }
        }, 'Ana');

        expect(mocks.downloadContentFromMessage).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'contract.pdf' }),
            'document'
        );
        expect(mocks.mkdir).toHaveBeenCalledWith(
            join(MEDIA_DIR, 'documents'),
            { recursive: true }
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('1234567890_contract.pdf'),
            Buffer.from('media')
        );
        expect(mocks.pdfParse).toHaveBeenCalledWith(Buffer.from('media'));
        expect(result.text).toContain('[Document Received: contract.pdf]');
        expect(result.text).toContain('MIME Type: application/pdf');
        expect(result.text).toContain('Size: 2.0 MB');
        expect(result.text).toContain('PDF text preview:');
        expect(result.text).toContain('First line');
        expect(result.text).toContain('Description: Read this');
        expect(result.text).not.toContain('A'.repeat(1300));
    });

    it('falls back gracefully when pdf parsing fails', async () => {
        const service = new IncomingMediaService(audioService as any);
        mocks.pdfParse.mockRejectedValueOnce(new Error('bad pdf'));

        const result = await service.process({
            kind: 'document',
            text: '[Document]',
            documentMessage: {
                fileName: 'scanned.pdf',
                mimetype: 'application/pdf',
                fileLength: 512000
            }
        }, 'Ana');

        expect(result.text).toContain('[Document Received: scanned.pdf]');
        expect(result.text).toContain(`Location: ${join(MEDIA_DIR, 'documents', '1234567890_scanned.pdf')}`);
        expect(result.text).toContain('PDF text was not extracted automatically. The file is saved at the path above.');
        expect(result.text).not.toContain('PDF text preview:');
    });

    it('keeps non-pdf document behavior unchanged', async () => {
        const service = new IncomingMediaService(audioService as any);

        const result = await service.process({
            kind: 'document',
            text: '[Document]',
            documentMessage: {
                fileName: 'notes.txt',
                mimetype: 'text/plain',
                fileLength: 1024
            }
        }, 'Ana');

        expect(mocks.pdfParse).not.toHaveBeenCalled();
        expect(result.text).toContain('[Document Received: notes.txt]');
        expect(result.text).not.toContain('PDF text preview:');
        expect(result.text).not.toContain('PDF text was not extracted automatically.');
    });
});

describe('IncomingMediaService — video & document edge branches', () => {
    const audioService = { transcribe: vi.fn() };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.downloadContentFromMessage.mockResolvedValue(streamFrom([Buffer.from('media')]));
        mocks.pdfParse.mockResolvedValue({ text: 'PDF body text' });
        vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    });

    it('downloads and saves videos as mp4', async () => {
        const service = new IncomingMediaService(audioService as any);

        const result = await service.process({
            kind: 'video',
            text: '[Video]',
            videoMessage: { mimetype: 'video/mp4' }
        }, 'Ana');

        expect(mocks.downloadContentFromMessage).toHaveBeenCalledWith(
            { mimetype: 'video/mp4' }, 'video'
        );
        expect(result).toEqual({
            text: '[Video]',
            savedMediaPath: join(MEDIA_DIR, 'video', 'video_1234567890.mp4')
        });
    });

    it('saves webm videos with the webm extension', async () => {
        const service = new IncomingMediaService(audioService as any);

        const result = await service.process({
            kind: 'video',
            text: '',
            videoMessage: { mimetype: 'video/webm;codecs=vp9' }
        }, 'Ana');

        expect(result.savedMediaPath).toBe(join(MEDIA_DIR, 'video', 'video_1234567890.webm'));
        // No fallback text -> readable placeholder with the saved path.
        expect(result.text).toContain('[Video received:');
    });

    it('returns a readable fallback when the video download fails', async () => {
        const service = new IncomingMediaService(audioService as any);
        mocks.downloadContentFromMessage.mockRejectedValue(new Error('too big'));

        await expect(service.process({
            kind: 'video',
            text: '[Video]',
            videoMessage: {}
        }, 'Ana')).resolves.toEqual({ text: '[Video download failed]' });
    });

    it('reports document download failures with the file name', async () => {
        const service = new IncomingMediaService(audioService as any);
        mocks.downloadContentFromMessage.mockRejectedValue(new Error('expired'));

        const result = await service.process({
            kind: 'document',
            text: '',
            documentMessage: { fileName: 'report.pdf', mimetype: 'application/pdf' }
        }, 'Ana');

        expect(result).toEqual({ text: '[Document: report.pdf (download failed)]' });
    });

    it('shows the PDF fallback notice when no text could be extracted', async () => {
        const service = new IncomingMediaService(audioService as any);
        mocks.pdfParse.mockResolvedValueOnce({ text: '   \n  ' });

        const result = await service.process({
            kind: 'document',
            text: '',
            documentMessage: { fileName: 'scan.pdf', mimetype: 'application/pdf' }
        }, 'Ana');

        expect(result.text).toContain('PDF text was not extracted automatically');
        expect(result.text).not.toContain('PDF body text');
    });

    it('includes short PDF previews verbatim (no truncation marker)', async () => {
        const service = new IncomingMediaService(audioService as any);

        const result = await service.process({
            kind: 'document',
            text: '',
            documentMessage: { fileName: 'short.pdf', mimetype: 'application/pdf' }
        }, 'Ana');

        expect(result.text).toContain('PDF body text');
        expect(result.text.endsWith('…')).toBe(false);
    });
});
