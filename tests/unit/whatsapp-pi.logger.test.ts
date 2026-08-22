import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn(),
    unlinkSync: vi.fn()
}));

vi.mock('../../src/services/storage-path.ts', () => ({
    createStoragePaths: () => ({ logDir: '/fake/logs' })
}));

vi.mock('fs', () => ({
    appendFileSync: f.appendFileSync,
    mkdirSync: f.mkdirSync,
    readdirSync: f.readdirSync,
    statSync: f.statSync,
    unlinkSync: f.unlinkSync,
    default: { appendFileSync: f.appendFileSync }
}));

import { WhatsAppPiLogger } from '../../src/services/whatsapp-pi.logger.ts';

// Deterministic timestamps for both file naming and line prefixes.
let isoCounter = 0;
const nextIso = () => {
    isoCounter += 1;
    return `2026-08-21T00:00:00.${String(isoCounter).padStart(3, '0')}Z`;
};

const statFile = (path: string, size: number, mtimeMs: number) => {
    f.statSync.mockImplementation(((p: string) => {
        if (p === path) return { size, mtimeMs };
        throw new Error('ENOENT');
    }) as any);
};

describe('WhatsAppPiLogger', () => {
    let logger: WhatsAppPiLogger;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        vi.spyOn(Date.prototype, 'toISOString').mockImplementation(nextIso);
        isoCounter = 0;
        f.readdirSync.mockReturnValue([]);
        f.statSync.mockReturnValue({ size: 0, mtimeMs: 1_800_000_000_000 });
        logger = new WhatsAppPiLogger(false, 5, 7);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates the log directory on construction and tolerates failures', () => {
        expect(f.mkdirSync).toHaveBeenCalledWith('/fake/logs', { recursive: true });

        f.mkdirSync.mockImplementation(() => {
            throw new Error('permission denied');
        });
        expect(() => new WhatsAppPiLogger()).not.toThrow();
    });

    it('always writes info logs to the current log file', () => {
        logger.info('[WhatsApp-Pi] info');

        expect(f.appendFileSync).toHaveBeenCalledTimes(1);
        const [path, line] = f.appendFileSync.mock.calls[0];
        expect(path).toMatch(/^\/fake\/logs\/whatsapp-pi-\d{4}-\d{2}-\d{2}T.*\.log$/);
        expect(String(line)).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[WhatsApp-Pi\] info\n$/);
    });

    it('writes warn/error/log levels with extra args appended', () => {
        logger.warn('[WhatsApp-Pi] warn');
        logger.error('[WhatsApp-Pi] error', 'detail');
        logger.log('[WhatsApp-Pi] log', 42);

        const levels = f.appendFileSync.mock.calls.map(([, line]) =>
            String(line).split('] [')[1]?.slice(0, 5)
        );
        expect(levels).toEqual(['WARN', 'ERROR', 'LOG']);
        expect(f.appendFileSync.mock.calls[1][1]).toContain('[WhatsApp-Pi] error detail');
        expect(f.appendFileSync.mock.calls[2][1]).toContain('[WhatsApp-Pi] log 42');
    });

    it('reuses the latest existing log file while under the size cap', () => {
        const existing = '/fake/logs/whatsapp-pi-old.log';
        f.readdirSync.mockReturnValue(['whatsapp-pi-old.log'] as any);
        // Fresh logger picks up existing file (size below cap).
        statFile(existing, 1024, 1_799_000_000_000);

        const reused = new WhatsAppPiLogger(false, 5, 7);
        reused.info('appended');

        expect(f.appendFileSync).toHaveBeenCalledWith(existing, expect.stringContaining('appended'));
    });

    it('rotates to a new file when the current log exceeds the size cap', () => {
        const full = '/fake/logs/whatsapp-pi-full.log';
        f.readdirSync.mockReturnValue(['whatsapp-pi-full.log'] as any);
        statFile(full, 6 * 1024 * 1024, 1_799_000_000_000); // above 5 MB cap

        const rotated = new WhatsAppPiLogger(false, 5, 7);
        rotated.info('after rotation');

        const [path] = f.appendFileSync.mock.calls[0];
        expect(path).not.toBe(full);
        expect(path).toMatch(/^\/fake\/logs\/whatsapp-pi-\d{4}-\d{2}-\d{2}T.*\.log$/);
    });

    it('deletes log files older than the retention window', () => {
        const stale = '/fake/logs/whatsapp-pi-stale.log';
        const fresh = '/fake/logs/whatsapp-pi-fresh.log';
        f.readdirSync.mockReturnValue(['whatsapp-pi-stale.log', 'whatsapp-pi-fresh.log'] as any);
        const dayMs = 24 * 60 * 60 * 1000;
        f.statSync.mockImplementation(((p: string) => {
            if (p === stale) return { size: 10, mtimeMs: 1_800_000_000_000 - 10 * dayMs };
            if (p === fresh) return { size: 10, mtimeMs: 1_800_000_000_000 - 1 * dayMs };
            throw new Error('ENOENT');
        }) as any);

        new WhatsAppPiLogger(false, 5, 7);

        expect(f.unlinkSync).toHaveBeenCalledWith(stale);
        expect(f.unlinkSync).not.toHaveBeenCalledWith(fresh);
    });

    it('caps the number of retained log files at 10', () => {
        const files = Array.from({ length: 13 }, (_, i) => {
            const name = `whatsapp-pi-${String(i).padStart(2, '0')}.log`;
            return { name, path: `/fake/logs/${name}` };
        });
        f.readdirSync.mockReturnValue(files.map(x => x.name) as any);
        // Sorted ascending by mtime: oldest have lowest index.
        f.statSync.mockImplementation(((p: string) => {
            const idx = files.findIndex(x => x.path === p);
            if (idx === -1) {
                if (typeof p === 'string' && p.startsWith('/fake/logs')) {
                    return { size: 0, mtimeMs: Date.now() };
                }
                throw new Error('ENOENT');
            }
            // All within the 7-day retention window; ordered oldest-first.
            return { size: 10, mtimeMs: 1_800_000_000_000 - 1 * 24 * 60 * 60 * 1000 + idx };
        }) as any);

        new WhatsAppPiLogger(false, 5, 7);

        // 13 files -> oldest 3 removed.
        expect(f.unlinkSync).toHaveBeenCalledTimes(3);
        expect(f.unlinkSync).toHaveBeenCalledWith(files[0].path);
        expect(f.unlinkSync).toHaveBeenCalledWith(files[2].path);
        expect(f.unlinkSync).not.toHaveBeenCalledWith(files[12].path);
    });

    it('updateConfig clamps sizes to a minimum of 1', () => {
        logger.updateConfig(0, -5);
        // Internal clamp: max size becomes >= 1MB; hard to observe directly,
        // so verify via rotation behaviour: 1 MB cap means a 2 MB file rotates.
        const big = '/fake/logs/whatsapp-pi-big.log';
        f.readdirSync.mockReturnValue(['whatsapp-pi-big.log'] as any);
        statFile(big, 2 * 1024 * 1024, 1_800_000_000_000);

        const clamped = new WhatsAppPiLogger(false, 5, 7);
        clamped.updateConfig(0, 7);
        clamped.info('rotates because cap clamped to 1MB');

        const [path] = f.appendFileSync.mock.calls[0];
        expect(path).not.toBe(big);
    });
});
