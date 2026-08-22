import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('baileys', () => ({
    downloadContentFromMessage: mocks.downloadContentFromMessage
}));

vi.mock('node:child_process', () => ({
    exec: mocks.exec
}));

vi.mock('node:fs', () => ({
    existsSync: mocks.existsSync,
    default: { existsSync: mocks.existsSync }
}));

vi.mock('node:os', () => ({
    homedir: mocks.homedir
}));

vi.mock('node:fs/promises', () => ({
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    readFile: mocks.readFile,
    default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile, readFile: mocks.readFile }
}));

const mocks = vi.hoisted(() => ({
    downloadContentFromMessage: vi.fn(),
    exec: vi.fn(),
    existsSync: vi.fn(),
    homedir: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn()
}));

const logger = {
    log: vi.fn(),
    error: vi.fn()
};

const MEDIA_DIR = join('/home/test', '.pi', 'whatsapp-medias');
const TRANSCRIBE_SCRIPT = join('/home/test', '.pi', 'agent', 'voice-transcription', 'transcribe.sh');

let AudioService: typeof import('../../src/services/audio.service.ts').AudioService;

const createStream = (...chunks: Buffer[]) => (async function* () {
    for (const chunk of chunks) {
        yield chunk;
    }
})();

// promisify(exec) expects exec(command, callback)
const setupExec = (stdout = '', stderr = '') => {
    mocks.exec.mockImplementation((_command: string, callback: (error?: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout, stderr });
        return undefined as never;
    });
};

describe('AudioService', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        logger.log.mockClear();
        logger.error.mockClear();
        vi.spyOn(Date, 'now').mockReturnValue(1234567890);
        mocks.homedir.mockReturnValue('/home/test');
        mocks.downloadContentFromMessage.mockResolvedValue(createStream(Buffer.from('media')));
        mocks.existsSync.mockReturnValue(true);
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.readFile.mockResolvedValue('');
        setupExec('transcribed text');
        ({ AudioService } = await import('../../src/services/audio.service.ts'));
    });

    it('creates media directory when it does not exist', () => {
        mocks.existsSync.mockReturnValue(false);

        new AudioService(logger as any);

        expect(mocks.mkdir).toHaveBeenCalledWith(MEDIA_DIR, { recursive: true });
    });

    it('does not throw when media directory creation fails', () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.mkdir.mockRejectedValue(new Error('mkdir denied'));

        expect(() => new AudioService(logger as any)).not.toThrow();
    });

    it('returns trimmed stdout from the sherpa-onnx transcribe script when available', async () => {
        setupExec('  áudio transcrito  \n');

        const service = new AudioService(logger as any);
        const audioMessage = { id: 'audio-1' };

        await expect(service.transcribe(audioMessage)).resolves.toBe('áudio transcrito');

        const inputPath = join(MEDIA_DIR, 'audio_1234567890.ogg');
        expect(mocks.downloadContentFromMessage).toHaveBeenCalledWith(audioMessage, 'audio');
        expect(mocks.writeFile).toHaveBeenCalledWith(inputPath, Buffer.from('media'));
        expect(mocks.exec).toHaveBeenCalledWith(`${TRANSCRIBE_SCRIPT} "${inputPath}"`, expect.any(Function));
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('falls back to the whisper command when the sherpa script is missing', async () => {
        // First existsSync call (constructor) and second (useSherpaOnnx check) both consult this.
        mocks.existsSync.mockImplementation((p: string) => !String(p).includes('transcribe.sh'));

        const service = new AudioService(logger as any);

        await service.transcribe({ id: 'audio-2' });

        const inputPath = join(MEDIA_DIR, 'audio_1234567890.ogg');
        const whisperPath = join('/home/test', '.local', 'bin', 'whisper');
        expect(mocks.exec).toHaveBeenCalledWith(
            `${whisperPath} "${inputPath}" --model small --language pt --output_format txt --output_dir "${MEDIA_DIR}" --fp16 False`,
            expect.any(Function)
        );
    });

    it('reads the legacy .txt file when stdout is empty', async () => {
        setupExec('');
        mocks.readFile.mockResolvedValue('legacy text\n');

        const service = new AudioService(logger as any);

        await expect(service.transcribe({ id: 'audio-3' })).resolves.toBe('legacy text');
        expect(mocks.readFile).toHaveBeenCalledWith(join(MEDIA_DIR, 'audio_1234567890.txt'), 'utf8');
    });

    it('returns the empty-transcription fallback when there is no output at all', async () => {
        setupExec('');
        mocks.existsSync.mockImplementation((p: string) => !String(p).endsWith('.txt'));

        const service = new AudioService(logger as any);

        await expect(service.transcribe({ id: 'audio-4' })).resolves.toBe('[Empty transcription]');
    });

    it('returns a formatted error when audio download fails', async () => {
        mocks.downloadContentFromMessage.mockRejectedValue(new Error('download failed'));

        const service = new AudioService(logger as any);

        await expect(service.transcribe({ id: 'audio-5' })).resolves.toBe(
            '[Transcription error: download failed]'
        );

        expect(logger.error).toHaveBeenCalled();
    });

    it('returns a formatted error when the transcription command fails', async () => {
        mocks.exec.mockImplementation((_command: string, callback: (error?: Error | null) => void) => {
            callback(new Error('ffmpeg exploded'));
            return undefined as never;
        });

        const service = new AudioService(logger as any);

        await expect(service.transcribe({ id: 'audio-6' })).resolves.toBe(
            '[Transcription error: ffmpeg exploded]'
        );
        expect(logger.error).toHaveBeenCalled();
    });
});
