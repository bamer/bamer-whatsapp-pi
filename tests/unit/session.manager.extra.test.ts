import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const f = vi.hoisted(() => ({
    fileLog: vi.fn(),
    useMultiFileAuthState: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(),
    ensureStorageRoots: vi.fn(),
    migrateLegacyStorage: vi.fn()
}));

vi.mock('../../src/services/storage-path.ts', () => ({
    fileLog: f.fileLog,
    ensureStorageDirectories: f.ensureStorageRoots,
    migrateLegacyStorage: f.migrateLegacyStorage,
    createStoragePaths: (root = '/fake/root', legacyRoot = '/fake/legacy') => ({
        root,
        legacyRoot,
        authStateDir: join(root, 'auth'),
        configPath: join(root, 'config.json'),
        recentsDir: join(root, 'recents'),
        recentsPath: join(root, 'recents', 'recents.json'),
        logDir: root,
        logPath: join(root, 'whatsapp-pi.log'),
        mediaDir: join(root, 'whatsapp-medias'),
        contactsPath: join(root, 'contacts.json')
    }),
    getDefaultStorageRoot: () => '/fake/root',
    getDefaultLegacyStorageRoot: () => '/fake/legacy'
}));

vi.mock('baileys', () => ({
    useMultiFileAuthState: f.useMultiFileAuthState,
    downloadContentFromMessage: vi.fn()
}));

vi.mock('fs/promises', () => ({
    mkdir: f.mkdir,
    readdir: f.readdir,
    readFile: f.readFile,
    rename: f.rename,
    rm: f.rm,
    writeFile: f.writeFile,
    default: {}
}));

import { SessionManager } from '../../src/services/session.manager.ts';

const ROOT = '/fake/root';
const CONFIG_PATH = join(ROOT, 'config.json');
const AUTH_DIR = join(ROOT, 'auth');

// A manager with mocked FS. Default: no config file, no creds.
const makeManager = () => {
    f.readFile.mockRejectedValue(new Error('ENOENT'));
    f.writeFile.mockResolvedValue(undefined);
    f.mkdir.mockResolvedValue(undefined);
    f.rename.mockResolvedValue(undefined);
    f.rm.mockResolvedValue(undefined);
    f.readdir.mockResolvedValue([]);
    return new SessionManager();
};

describe('SessionManager — extra coverage', () => {
    let sm: SessionManager;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        sm = makeManager();
    });

    describe('cleanContact', () => {
        it('accepts a plain string as number-only contact', () => {
            expect(SessionManager.cleanContact('+33123456789')).toEqual({ number: '+33123456789' });
        });

        it('unwraps nested {number:{number:...}} objects from legacy bugs', () => {
            expect(SessionManager.cleanContact({ number: { number: '+111' }, name: 'A' }))
                .toEqual({ number: '+111', name: 'A', sendNumber: undefined });
            expect(SessionManager.cleanContact({ number: { number: { number: '+222' } } }))
                .toEqual({ number: '+222', name: undefined, sendNumber: undefined });
        });

        it('returns null for invalid shapes', () => {
            expect(SessionManager.cleanContact(null)).toBeNull();
            expect(SessionManager.cleanContact(42)).toBeNull();
            expect(SessionManager.cleanContact({ noNumberHere: true })).toBeNull();
        });
    });

    describe('setGroupJidForAuth', () => {
        it('sanitizes the group JID into a dedicated auth directory', () => {
            sm.setGroupJidForAuth('120363409409770410@g.us');
            expect(sm.getAuthStateDir()).toBe(join(ROOT, 'auth-120363409409770410_g_us'));
        });
    });

    describe('config loading and recovery', () => {
        it('keeps defaults when the config file is missing', async () => {
            await sm.ensureInitialized();

            expect(sm.getStatus()).toBe('logged-out');
            expect(sm.getAutoConnect()).toBe(false);
            expect(sm.getAgentSignature()).toBe('π');
            expect(sm.getAssistantName()).toBe('Agent Pi');
        });

        it('loads a valid config with all fields', async () => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === join(AUTH_DIR, 'creds.json')) return '{}';
                if (path === CONFIG_PATH) {
                    return JSON.stringify({
                        status: 'connected',
                        hasAuthState: true,
                        brandVisibility: false,
                        openaiKey: 'sk-test',
                        visionModel: 'gpt-4o-mini',
                        operatorJid: '33684136128@s.whatsapp.net',
                        autoConnect: true,
                        assistantName: 'Carl',
                        agentSignature: 'π',
                        logMaxSizeMB: 10,
                        logRetentionDays: 30,
                        allowList: [{ number: '+33123456789', name: 'Ana' }],
                        allowedGroups: [{ number: '123@g.us', name: 'Family' }],
                        ignoredNumbers: [{ number: '+39988776655' }],
                        updateList: [{ number: '+33684136128' }]
                    });
                }
                throw new Error('ENOENT');
            });

            await sm.ensureInitialized();

            expect(sm.getStatus()).toBe('connected');
            expect(sm.getBrandVisibility()).toBe(false);
            expect(sm.getOpenaiKey()).toBe('sk-test');
            expect(sm.getVisionModel()).toBe('gpt-4o-mini');
            expect(sm.getOperatorJid()).toBe('33684136128@s.whatsapp.net');
            expect(sm.getAutoConnect()).toBe(true);
            expect(sm.getAssistantName()).toBe('Carl');
            expect(sm.getLogMaxSizeMB()).toBe(10);
            expect(sm.getLogRetentionDays()).toBe(30);
            expect(sm.getAllowList().map((c) => c.number)).toEqual(['+33123456789']);
            expect(sm.getAllowedGroups().map((c) => c.number)).toEqual(['123@g.us']);
            expect(sm.getIgnoredNumbers()).toHaveLength(1);
            expect(sm.getUpdateList().map((c) => c.number)).toEqual(['+33684136128']);
        });

        it('recovers the first JSON object when the file has trailing garbage', async () => {
            const goodConfig = JSON.stringify({ status: 'connected', allowList: [{ number: '+111' }] });
            // Simulates a truncated double-write: valid object then junk (with braces inside strings).
            const corrupted = goodConfig + '{"broken": "va{l \\"q}uote"';

            f.readFile.mockImplementation(async (path: string) => {
                if (path === join(AUTH_DIR, 'creds.json')) return '{}';
                if (path === CONFIG_PATH) return corrupted;
                throw new Error('ENOENT');
            });

            await sm.ensureInitialized();

            expect(sm.getStatus()).toBe('connected');
            expect(sm.getAllowList().map((c) => c.number)).toEqual(['+111']);
            // Recovery triggers an immediate re-save of a clean config.
            expect(f.writeFile).toHaveBeenCalled();
        });

        it('tolerates a totally unparseable config (no JSON object found)', async () => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) return 'not json at all ]]';
                throw new Error('ENOENT');
            });

            await expect(sm.ensureInitialized()).resolves.toBeUndefined();
            expect(sm.getStatus()).toBe('logged-out');
        });

        it('migrates group JIDs mistakenly stored in allowList into allowedGroups', async () => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) {
                    return JSON.stringify({
                        allowList: [
                            { number: '+33123456789' },
                            { number: '999@g.us', name: 'Stray Group' }
                        ]
                    });
                }
                throw new Error('ENOENT');
            });

            await sm.ensureInitialized();

            expect(sm.getAllowList().map((c) => c.number)).toEqual(['+33123456789']);
            expect(sm.getAllowedGroups().map((c) => c.number)).toContain('999@g.us');
        });

        it('mergeContacts backfills missing names without overwriting existing ones', async () => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) {
                    return JSON.stringify({
                        allowedGroups: [{ number: '1@g.us', name: 'Kept' }],
                        allowList: [
                            { number: '2@g.us' },
                            { number: '1@g.us' } // duplicate across lists -> migrated & merged
                        ]
                    });
                }
                throw new Error('ENOENT');
            });

            await sm.ensureInitialized();

            const groups = sm.getAllowedGroups();
            const kept = groups.find((g) => g.number === '1@g.us');
            expect(kept?.name).toBe('Kept'); // not overwritten
            expect(groups.map((g) => g.number)).toContain('2@g.us');
        });
    });

    describe('saveConfig robustness', () => {
        it('preserves an externally modified updateList instead of the in-memory one', async () => {
            // Disk already contains an updateList written by another process.
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) {
                    return JSON.stringify({ updateList: [{ number: '+external', name: 'External Edit' }] });
                }
                throw new Error('ENOENT');
            });

            await sm.saveConfig();

            const saved = JSON.parse(f.writeFile.mock.calls[0][1]);
            expect(saved.updateList).toEqual([{ number: '+external', name: 'External Edit' }]);
        });

        it('falls back to direct write when atomic rename fails (Windows EPERM)', async () => {
            f.rename.mockRejectedValue(new Error('EPERM'));
            f.readFile.mockRejectedValue(new Error('ENOENT'));

            await sm.saveConfig();

            expect(f.writeFile).toHaveBeenCalledWith(CONFIG_PATH, expect.stringContaining('"allowList"'));
            expect(f.rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true });
        });

        it('cleans up the temp file and logs on total failure', async () => {
            f.writeFile.mockRejectedValue(new Error('disk full'));
            f.readFile.mockRejectedValue(new Error('ENOENT'));

            await sm.saveConfig();

            expect(f.rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true });
            expect(f.fileLog).toHaveBeenCalledWith(expect.stringContaining('Failed to save config'));
        });
    });

    describe('stale temp file cleanup', () => {
        it('removes leftover config .tmp files on init', async () => {
            f.readdir.mockResolvedValue([
                'config.json.1234.1800000000000.tmp',
                'other.tmp',
                'contacts.json'
            ] as any);

            await sm.ensureInitialized();

            expect(f.rm).toHaveBeenCalledTimes(1);
            expect(f.rm).toHaveBeenCalledWith(join(ROOT, 'config.json.1234.1800000000000.tmp'), { force: true });
        });

        it('tolerates a missing directory while cleaning temp files', async () => {
            f.readdir.mockRejectedValue(new Error('ENOENT'));

            await expect(sm.ensureInitialized()).resolves.toBeUndefined();
        });
    });

    describe('allow-list CRUD edge cases', () => {
        beforeEach(async () => {
            f.readFile.mockRejectedValue(new Error('ENOENT'));
            await sm.ensureInitialized();
            f.writeFile.mockClear();
        });

        it('addNumber unwraps nested objects and rejects non-string numbers', async () => {
            await sm.addNumber({ number: { number: '+111' } } as any);
            expect(sm.isAllowed('+111')).toBe(true);

            const before = sm.getAllowList().length;
            await sm.addNumber(42 as any);
            expect(sm.getAllowList().length).toBe(before);
            expect(f.fileLog).toHaveBeenCalledWith(expect.stringContaining('[SessionManager] Attempted to add invalid number'));
        });

        it('addNumber redirects group JIDs to allowedGroups', async () => {
            await sm.addNumber('777@g.us', 'Redirected');

            expect(sm.isAllowedGroup('777@g.us')).toBe(true);
            expect(sm.getAllowList()).toHaveLength(0);
        });

        it('addNumber backfills the alias on an existing entry without saving again', async () => {
            await sm.addNumber('+111');           // save #1
            f.writeFile.mockClear();
            await sm.addNumber('+111', 'Ana');    // backfills name -> save
            expect(sm.getAllowList()[0].name).toBe('Ana');
            expect(f.writeFile).toHaveBeenCalledTimes(1);

            f.writeFile.mockClear();
            await sm.addNumber('+111', 'Ana 2');  // name already set -> no save
            expect(sm.getAllowList()[0].name).toBe('Ana');
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('removeNumber removes by exact number', async () => {
            await sm.addNumber('+111');
            await sm.removeNumber('+111');
            expect(sm.getAllowList()).toHaveLength(0);
        });

        it('setContactSendNumber / removeContactSendNumber round-trip', async () => {
            await sm.addNumber('+111');
            await sm.setContactSendNumber('+111', '+5511999998888');
            expect(sm.getAllowList()[0].sendNumber).toBe('+5511999998888');

            await sm.removeContactSendNumber('111@s.whatsapp.net');
            expect(sm.getAllowList()[0].sendNumber).toBeUndefined();
        });

        it('send-number setters ignore unknown contacts without throwing', async () => {
            await expect(sm.setContactSendNumber('+unknown', '+555')).resolves.toBeUndefined();
            await expect(sm.removeContactSendNumber('+unknown')).resolves.toBeUndefined();
        });

        it('alias setters ignore empty aliases and unknown contacts', async () => {
            await sm.addNumber('+111', 'Original');
            f.writeFile.mockClear();

            await sm.setAllowedContactAlias('+111', '   '); // empty -> early return
            expect(sm.getAllowList()[0].name).toBe('Original');

            await sm.setAllowedContactAlias('+unknown', 'X'); // unknown -> no-op
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('removeAllowedContactAlias only acts when an alias exists', async () => {
            await sm.addNumber('+111', 'Ana');
            await sm.removeAllowedContactAlias('+111');
            expect(sm.getAllowList()[0].name).toBeUndefined();

            f.writeFile.mockClear();
            await sm.removeAllowedContactAlias('+111'); // no alias left -> no save
            await sm.removeAllowedContactAlias('+unknown');
            expect(f.writeFile).not.toHaveBeenCalled();
        });
    });

    describe('group CRUD edge cases', () => {
        beforeEach(async () => {
            f.readFile.mockRejectedValue(new Error('ENOENT'));
            await sm.ensureInitialized();
            f.writeFile.mockClear();
        });

        it('addAllowedGroup rejects non-group JIDs', async () => {
            await sm.addAllowedGroup('+33123456789');
            expect(sm.getAllowedGroups()).toHaveLength(0);
            expect(f.fileLog).toHaveBeenCalledWith(expect.stringContaining('[SessionManager] Attempted to add invalid number'));
        });

        it('addAllowedGroup backfills name like addNumber', async () => {
            await sm.addAllowedGroup('1@g.us');
            f.writeFile.mockClear();
            await sm.addAllowedGroup('1@g.us', 'Named');
            expect(sm.getAllowedGroup('1@g.us')?.name).toBe('Named');
            expect(f.writeFile).toHaveBeenCalledTimes(1);

            f.writeFile.mockClear();
            await sm.addAllowedGroup('1@g.us', 'Other');
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('removeAllowedGroup removes by JID', async () => {
            await sm.addAllowedGroup('1@g.us');
            await sm.removeAllowedGroup('1@g.us');
            expect(sm.getAllowedGroups()).toHaveLength(0);
        });

        it('group alias setters guard against empty alias, unknown group and missing alias', async () => {
            await sm.addAllowedGroup('1@g.us', 'G');

            await sm.setAllowedGroupAlias('1@g.us', '  ');
            expect(sm.getAllowedGroup('1@g.us')?.name).toBe('G');

            await sm.setAllowedGroupAlias('unknown@g.us', 'X');
            await sm.removeAllowedGroupAlias('unknown@g.us');
            expect(sm.getAllowedGroups()[0].name).toBe('G');

            await sm.removeAllowedGroupAlias('1@g.us');
            expect(sm.getAllowedGroup('1@g.us')?.name).toBeUndefined();

            f.writeFile.mockClear();
            await sm.removeAllowedGroupAlias('1@g.us'); // nothing left -> no save
            expect(f.writeFile).not.toHaveBeenCalled();
        });
    });

    describe('ignored numbers tracking', () => {
        it('trackIgnoredNumber skips allowed numbers and duplicates', async () => {
            await sm.addNumber('+allowed');
            f.writeFile.mockClear();

            await sm.trackIgnoredNumber('+allowed');      // allowed -> skip
            expect(sm.getIgnoredNumbers()).toHaveLength(0);
            expect(f.writeFile).not.toHaveBeenCalled();

            await sm.trackIgnoredNumber('+stranger', 'Stranger');
            expect(sm.getIgnoredNumbers()).toEqual([{ number: '+stranger', name: 'Stranger' }]);

            f.writeFile.mockClear();
            await sm.trackIgnoredNumber('+stranger');     // already ignored -> skip
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('adding a previously ignored number clears it from the ignore list', async () => {
            await sm.trackIgnoredNumber('+333');
            expect(sm.getIgnoredNumbers()).toHaveLength(1);

            await sm.addNumber('+333');
            expect(sm.getIgnoredNumbers()).toHaveLength(0);
        });

        it('removeIgnoredNumber removes by number', async () => {
            await sm.trackIgnoredNumber('+444');
            await sm.removeIgnoredNumber('+444');
            expect(sm.getIgnoredNumbers()).toHaveLength(0);
        });
    });

    describe('update list', () => {
        it('isAllowedUpdateTarget reloads from disk and matches +prefix, raw, LID and group formats', async () => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) {
                    return JSON.stringify({
                        updateList: [
                            { number: '+33684136128' },
                            { number: '64175502004378@lid' },
                            { number: '120363409409770410@g.us' }
                        ]
                    });
                }
                throw new Error('ENOENT');
            });

            await expect(sm.isAllowedUpdateTarget('33684136128@s.whatsapp.net')).resolves.toBe(true);
            await expect(sm.isAllowedUpdateTarget('64175502004378@lid')).resolves.toBe(true); // full LID JID as received
            await expect(sm.isAllowedUpdateTarget('120363409409770410@g.us')).resolves.toBe(true);
            await expect(sm.isAllowedUpdateTarget('+99999999@s.whatsapp.net')).resolves.toBe(false);
        });

        it('reload failure keeps the in-memory list (no crash)', async () => {
            await sm.addUpdateNumber('+inmemory');
            f.readFile.mockRejectedValue(new Error('ENOENT'));

            await expect(sm.isAllowedUpdateTarget('+inmemory')).resolves.toBe(true);
        });

        it('addUpdateNumber accepts object args, rejects junk, backfills names', async () => {
            await sm.addUpdateNumber({ number: '+obj' } as any);
            expect(sm.getUpdateList().map((c) => c.number)).toContain('+obj');

            await sm.addUpdateNumber(undefined as any);
            await sm.addUpdateNumber('');
            expect(sm.getUpdateList()).toHaveLength(1);

            f.writeFile.mockClear();
            await sm.addUpdateNumber('+obj', 'Named');
            expect(sm.getUpdateList()[0].name).toBe('Named');
            expect(f.writeFile).toHaveBeenCalledTimes(1);

            f.writeFile.mockClear();
            await sm.addUpdateNumber('+obj', 'Again');
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('removeUpdateNumber filters by number', async () => {
            await sm.addUpdateNumber('+a');
            await sm.addUpdateNumber('+b');
            await sm.removeUpdateNumber('+a');
            expect(sm.getUpdateList().map((c) => c.number)).toEqual(['+b']);
        });
    });

    describe('validateAndDeduplicateContacts warnings', () => {
        const seed = async (config: object) => {
            f.readFile.mockImplementation(async (path: string) => {
                if (path === CONFIG_PATH) return JSON.stringify(config);
                throw new Error('ENOENT');
            });
            await sm.ensureInitialized();
            f.writeFile.mockClear();
        };

        it('warns for duplicates within allowList and cross-list collisions', async () => {
            await seed({
                allowList: [{ number: '+clean1' }],
                allowedGroups: [{ number: 'g@g.us' }],
                ignoredNumbers: [],
                updateList: []
            });
            // Validation already deduped at load time — inject duplicates afterwards.
            (sm as any).allowList.push({ number: '+dup' }, { number: '+dup', name: 'Dup Alias' }, { number: 'g@g.us' });
            (sm as any).allowedGroups.push({ number: '+cross' });
            (sm as any).ignoredNumbers.push({ number: '+cross', name: 'Cross Ignored' });
            (sm as any).updateList.push({ number: '+cross', name: 'Cross Update' });

            const warnings = sm.validateAndDeduplicateContacts();

            expect(warnings.some((w) => w.includes('Duplicate number in allowList: +dup'))).toBe(true);
            expect(warnings.some((w) => w.includes('exists in allowList') && w.includes('and allowedGroups'))).toBe(true);
            expect(warnings.some((w) => w.includes('exists in allowedGroups') && w.includes('and ignoredNumbers'))).toBe(true);
            expect(warnings.some((w) => w.includes('and updateList'))).toBe(true);
            // Dedup applied: single +dup remains in allowList.
            expect(sm.getAllowList().filter((c) => c.number === '+dup')).toHaveLength(1);
        });

        it('warns when the same number spans three lists with alias context', async () => {
            await seed({ allowList: [], ignoredNumbers: [], allowedGroups: [], updateList: [] });
            (sm as any).ignoredNumbers.push({ number: '+ig' });
            (sm as any).allowedGroups.push({ number: '+ig', name: 'Also Ignored' });
            (sm as any).updateList.push({ number: '+ig', name: 'Also Update' });

            const warnings = sm.validateAndDeduplicateContacts();

            expect(warnings.some((w) => w.includes('+ig exists in allowedGroups (alias: Also Ignored) and ignoredNumbers'))).toBe(true);
            expect(warnings.some((w) => w.includes('(alias: Also Ignored) and updateList'))).toBe(true);
        });

        it('returns no warnings for clean lists', async () => {
            await seed({
                allowList: [{ number: '+1' }],
                allowedGroups: [{ number: '1@g.us' }],
                ignoredNumbers: [{ number: '+2' }],
                updateList: [{ number: '+3' }]
            });

            expect(sm.validateAndDeduplicateContacts()).toEqual([]);
        });
    });

    describe('auth state lifecycle', () => {
        it('getAuthState delegates to Baileys with the configured auth dir', async () => {
            f.useMultiFileAuthState.mockResolvedValue({ state: {}, saveCreds: vi.fn() });

            await sm.getAuthState();

            expect(f.useMultiFileAuthState).toHaveBeenCalledWith(AUTH_DIR);
            expect(f.ensureStorageRoots).toHaveBeenCalledWith(expect.objectContaining({ authStateDir: AUTH_DIR }));
        });

        it('markAuthStateAvailable saves once and is idempotent', async () => {
            await sm.markAuthStateAvailable();
            f.readFile.mockImplementation(async (path: string) => {
                if (path === join(AUTH_DIR, 'creds.json')) return '{}';
                throw new Error('ENOENT');
            });
            await expect(sm.isRegistered()).resolves.toBe(true);

            f.writeFile.mockClear();
            await sm.markAuthStateAvailable(); // already true -> no save
            expect(f.writeFile).not.toHaveBeenCalled();
        });

        it('deleteAuthState resets status and tolerates failures', async () => {
            await sm.setStatus('connected');
            await sm.deleteAuthState();

            expect(sm.getStatus()).toBe('logged-out');

            f.rm.mockRejectedValue(new Error('EBUSY'));
            f.writeFile.mockClear();
            await sm.deleteAuthState(); // error path: log, keep going
            expect(f.fileLog).toHaveBeenCalledWith(expect.stringContaining('Failed'));
        });

        it('syncAuthStateFromDisk downgrades connected->disconnected when creds vanish', async () => {
            await sm.setStatus('connected');
            // No creds.json on disk (readFile rejects).

            await sm.isRegistered(); // triggers sync

            expect(sm.getStatus()).toBe('disconnected');
        });

        it('syncAuthStateFromDisk keeps connected status when creds exist', async () => {
            await sm.setStatus('connected');
            f.readFile.mockImplementation(async (path: string) => {
                if (path === join(AUTH_DIR, 'creds.json')) return '{}';
                throw new Error('ENOENT');
            });

            const registered = await sm.isRegistered();

            expect(registered).toBe(true);
            expect(sm.getStatus()).toBe('connected');
        });
    });

    describe('settings setters persist through saveConfig', () => {
        beforeEach(() => {
            f.readFile.mockRejectedValue(new Error('ENOENT'));
            f.writeFile.mockClear();
        });

        it.each([
            ['setAutoConnect', true, 'getAutoConnect', true],
            ['setBrandVisibility', false, 'getBrandVisibility', false],
            ['setOpenaiKey', 'sk-new', 'getOpenaiKey', 'sk-new'],
            ['setVisionModel', 'custom-model', 'getVisionModel', 'custom-model'],
            ['setOperatorJid', 'op@s.whatsapp.net', 'getOperatorJid', 'op@s.whatsapp.net'],
        ] as const)('%s persists the new value', async (setter, value, getter, expected) => {
            await (sm as any)[setter](value);
            expect((sm as any)[getter]()).toBe(expected);
            expect(f.writeFile).toHaveBeenCalled();
        });

        it('setAssistantName falls back to the default on empty input', async () => {
            await sm.setAssistantName('');
            expect(sm.getAssistantName()).toBe('Agent Pi');
        });
    });
});

describe('SessionManager — setters, warnings and parser edge cases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('round-trips the log size and retention setters with persistence', async () => {
        const sm = makeManager();
        await sm.ensureInitialized();
        f.writeFile.mockClear();

        await sm.setLogMaxSizeMB(12);
        expect(sm.getLogMaxSizeMB()).toBe(12);
        expect(f.writeFile).toHaveBeenCalled();

        f.writeFile.mockClear();
        await sm.setLogRetentionDays(45);
        expect(sm.getLogRetentionDays()).toBe(45);
        expect(f.writeFile).toHaveBeenCalled();
    });

    it('logs validation warnings when a config contains duplicate numbers', async () => {
        f.readFile.mockImplementation(async (path: string) => {
            if (path === join(AUTH_DIR, 'creds.json')) return '{}';
            if (path === CONFIG_PATH) {
                return JSON.stringify({
                    status: 'connected',
                    allowList: [
                        { number: '+111', name: 'Ana' },
                        { number: '+111', name: 'Ana bis' }
                    ]
                });
            }
            throw new Error('ENOENT');
        });

        const sm = new SessionManager();
        await sm.ensureInitialized();

        const warningCalls = f.fileLog.mock.calls.filter(
            (c: any[]) => String(c[0]).includes('validation warnings')
        );
        expect(warningCalls.length).toBeGreaterThan(0);
        expect(String(warningCalls[0][0])).toContain('Duplicate number in allowList');
    });

    it('parses JSON strings containing escaped quotes and backslashes', async () => {
        const trickyName = 'Ben "The Boss" \\Admin\\';
        f.readFile.mockImplementation(async (path: string) => {
            if (path === join(AUTH_DIR, 'creds.json')) return '{}';
            if (path === CONFIG_PATH) {
                return JSON.stringify({
                    status: 'connected',
                    allowList: [{ number: '+111', name: trickyName }]
                });
            }
            throw new Error('ENOENT');
        });

        const sm = new SessionManager();
        await sm.ensureInitialized();

        expect(sm.getAllowList()[0].name).toBe(trickyName);
        expect(sm.getStatus()).toBe('connected');
    });

    it('exposes getValidationWarnings for the current lists', async () => {
        const sm = makeManager();
        await sm.ensureInitialized();

        // Clean state -> no warnings.
        expect(sm.getValidationWarnings()).toEqual([]);
    });

    it('backfills the alias when migrating a group JID already present in allowedGroups', async () => {
        // Group JIDs found in allowList are migrated into allowedGroups;
        // mergeContacts must backfill the name from the migrated entry.
        f.readFile.mockImplementation(async (path: string) => {
            if (path === join(AUTH_DIR, 'creds.json')) return '{}';
            if (path === CONFIG_PATH) {
                return JSON.stringify({
                    status: 'connected',
                    allowList: [{ number: '120363409409770410@g.us', name: 'Family' }],
                    allowedGroups: [{ number: '120363409409770410@g.us' }]
                });
            }
            throw new Error('ENOENT');
        });

        const sm = new SessionManager();
        await sm.ensureInitialized();

        expect(sm.getAllowList()).toHaveLength(0); // migrated out of allowList
        const groups = sm.getAllowedGroups().filter((c: any) => c.number === '120363409409770410@g.us');
        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('Family');
    });
});
