import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const f = vi.hoisted(() => ({
    access: vi.fn(),
    appendFileSync: vi.fn(),
    cp: vi.fn(),
    homedir: vi.fn().mockReturnValue('/home/testuser'),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn()
}));

vi.mock('fs/promises', () => ({
    access: f.access,
    cp: f.cp,
    mkdir: f.mkdir,
    readdir: f.readdir,
    stat: f.stat,
    default: {}
}));

vi.mock('fs', () => ({
    appendFileSync: f.appendFileSync,
    default: { appendFileSync: f.appendFileSync }
}));

vi.mock('os', () => ({
    homedir: f.homedir,
    default: { homedir: f.homedir }
}));

import {
    createStoragePaths,
    ensureStorageDirectories,
    fileLog,
    getDefaultStorageRoot,
    migrateLegacyStorage,
    pathExists
} from '../../src/services/storage-path.ts';

const HOME_ROOT = join('/home/testuser', '.pi', 'agent', 'extensions', 'whatsapp-pi');
const LEGACY_ROOT = join('/home/testuser', '.pi', 'agent', 'extension', 'whatsapp-pi');

describe('storage-path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        f.mkdir.mockResolvedValue(undefined);
        f.access.mockRejectedValue(new Error('ENOENT'));
        f.readdir.mockResolvedValue([]);
        f.stat.mockResolvedValue({ isDirectory: () => false });
        f.cp.mockResolvedValue(undefined);
        f.appendFileSync.mockImplementation(() => {});
    });

    describe('createStoragePaths / getDefaultStorageRoot', () => {
        it('builds every derived path from the root', () => {
            const paths = createStoragePaths();

            expect(paths.root).toBe(HOME_ROOT);
            expect(paths.legacyRoot).toBe(LEGACY_ROOT);
            expect(paths.authStateDir).toBe(join(HOME_ROOT, 'auth'));
            expect(paths.configPath).toBe(join(HOME_ROOT, 'config.json'));
            expect(paths.recentsDir).toBe(join(HOME_ROOT, 'recents'));
            expect(paths.recentsPath).toBe(join(HOME_ROOT, 'recents', 'recents.json'));
            expect(paths.logDir).toBe(HOME_ROOT);
            expect(paths.logPath).toBe(join(HOME_ROOT, 'whatsapp-pi.log'));
            expect(paths.mediaDir).toBe(join(HOME_ROOT, 'whatsapp-medias'));
            expect(paths.contactsPath).toBe(join(HOME_ROOT, 'contacts.json'));
        });

        it('accepts custom roots and defaults to the standard root', () => {
            const custom = createStoragePaths('/custom/root', '/custom/legacy');
            expect(custom.root).toBe('/custom/root');
            expect(custom.authStateDir).toBe(join('/custom/root', 'auth'));
            expect(getDefaultStorageRoot()).toBe(HOME_ROOT);
        });
    });

    describe('ensureStorageDirectories', () => {
        it('creates root, auth, recents and log directories recursively', async () => {
            await ensureStorageDirectories({
                root: '/r',
                authStateDir: '/r/auth',
                recentsDir: '/r/recents',
                logDir: '/r'
            });

            expect(f.mkdir).toHaveBeenCalledTimes(4);
            expect(f.mkdir).toHaveBeenCalledWith('/r', { recursive: true });
            expect(f.mkdir).toHaveBeenCalledWith('/r/auth', { recursive: true });
            expect(f.mkdir).toHaveBeenCalledWith('/r/recents', { recursive: true });
        });
    });

    describe('pathExists', () => {
        it('returns true when access succeeds', async () => {
            f.access.mockResolvedValue(undefined);
            await expect(pathExists('/exists')).resolves.toBe(true);
        });

        it('returns false when access fails', async () => {
            await expect(pathExists('/missing')).resolves.toBe(false);
        });
    });

    describe('fileLog', () => {
        it('appends a timestamped line to the log file', () => {
            fileLog('hello debug');

            expect(f.appendFileSync).toHaveBeenCalledTimes(1);
            const [path, line] = f.appendFileSync.mock.calls[0];
            expect(path).toBe(join(HOME_ROOT, 'whatsapp-pi.log'));
            expect(String(line)).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello debug\n$/);
        });

        it('swallows write errors silently (best-effort logging)', () => {
            f.appendFileSync.mockImplementation(() => {
                throw new Error('disk full');
            });

            expect(() => fileLog('will fail')).not.toThrow();
        });
    });

    describe('migrateLegacyStorage', () => {
        it('returns false and only creates the root when no legacy dir exists', async () => {
            f.access.mockRejectedValue(new Error('ENOENT'));

            await expect(migrateLegacyStorage({ root: HOME_ROOT, legacyRoot: LEGACY_ROOT })).resolves.toBe(false);

            expect(f.mkdir).toHaveBeenCalledWith(HOME_ROOT, { recursive: true });
            expect(f.readdir).not.toHaveBeenCalled();
        });

        it('copies files from the legacy directory, skipping existing targets', async () => {
            // Legacy root exists AND the target file already exists in the new root.
            f.access.mockImplementation(async (p: string) => {
                if (p === LEGACY_ROOT || p === join(HOME_ROOT, 'config.json')) return undefined;
                throw new Error('ENOENT');
            });
            const dirent = { name: 'config.json', isDirectory: () => false };
            f.readdir.mockResolvedValue([dirent] as any);

            await migrateLegacyStorage({ root: HOME_ROOT, legacyRoot: LEGACY_ROOT });

            expect(f.stat).toHaveBeenCalledWith(join(LEGACY_ROOT, 'config.json'));
            expect(f.access).toHaveBeenCalledWith(join(HOME_ROOT, 'config.json'));
            expect(f.cp).not.toHaveBeenCalled(); // target exists -> skipped
        });

        it('copies missing files with preserveTimestamps', async () => {
            // Legacy root AND every probe path exists (target missing).
            // Must mock access for BOTH legacy roots (passed + fallback ~/.pi/whatsapp-pi)
            const FALLBACK_ROOT = join('/home/testuser', '.pi', 'whatsapp-pi');
            f.access.mockImplementation(async (p: string) => {
                if (p === LEGACY_ROOT || p === FALLBACK_ROOT) return undefined;
                throw new Error('ENOENT');
            });
            f.readdir.mockImplementation(async (dir: string) => {
                if (dir === LEGACY_ROOT) return [{ name: 'recents.json', isDirectory: () => false }] as any;
                return [];
            });

            await migrateLegacyStorage({ root: HOME_ROOT, legacyRoot: LEGACY_ROOT });

            expect(f.cp).toHaveBeenCalledWith(
                join(LEGACY_ROOT, 'recents.json'),
                join(HOME_ROOT, 'recents.json'),
                { force: false, preserveTimestamps: true }
            );
        });

        it('recursively copies directories', async () => {
            const FALLBACK_ROOT = join('/home/testuser', '.pi', 'whatsapp-pi');
            f.access.mockImplementation(async (p: string) => {
                if (p === LEGACY_ROOT || p === FALLBACK_ROOT) return undefined;
                throw new Error('ENOENT');
            });
            const authDir = { name: 'auth', isDirectory: () => true };
            const credsFile = { name: 'creds.json', isDirectory: () => false };
            f.readdir.mockImplementation(async (dir: string) => {
                if (dir === LEGACY_ROOT) return [authDir] as any;
                return [credsFile] as any;
            });
            f.stat.mockImplementation(async (p: string) => ({
                isDirectory: () => p === join(LEGACY_ROOT, 'auth')
            }) as any);

            await migrateLegacyStorage({ root: HOME_ROOT, legacyRoot: LEGACY_ROOT });

            expect(f.mkdir).toHaveBeenCalledWith(join(HOME_ROOT, 'auth'), { recursive: true });
            expect(f.cp).toHaveBeenCalledWith(
                join(LEGACY_ROOT, 'auth', 'creds.json'),
                join(HOME_ROOT, 'auth', 'creds.json'),
                { force: false, preserveTimestamps: true }
            );
        });

        it('ignores a legacy root equal to the current root and dedupes duplicates', async () => {
            f.access.mockRejectedValue(new Error('ENOENT'));

            // legacyRoot === root should be filtered out entirely.
            await expect(migrateLegacyStorage({ root: HOME_ROOT, legacyRoot: HOME_ROOT })).resolves.toBe(false);

            // The second default candidate (~/.pi/whatsapp-pi) also doesn't exist.
            expect(f.readdir).not.toHaveBeenCalled();
        });
    });
});
