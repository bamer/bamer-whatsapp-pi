import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('i18n locale override', () => {
    const ORIGINAL_ARGV = process.argv;

    beforeEach(() => {
        vi.resetModules();
        delete process.env.WHATSAPP_PI_LOCALE;
    });

    afterEach(() => {
        process.argv = ORIGINAL_ARGV;
        delete process.env.WHATSAPP_PI_LOCALE;
        vi.resetModules();
    });

    const load = async () => {
        const mod = await import('../../src/i18n.ts');
        return mod as any;
    };

    it('honors the --whatsapp-pi-locale=<locale> argument', async () => {
        process.argv = ['node', 'pi', '--whatsapp-pi-locale=fr'];
        const i18n = await load();
        i18n.initI18n({});
        expect(i18n.t('service.whatsapp.connected')).toContain('Connecté');
    });

    it('honors the separated --whatsapp-pi_locale <locale> argument form', async () => {
        process.argv = ['node', 'pi', '--whatsapp-pi-locale', 'fr'];
        const i18n = await load();
        i18n.initI18n({});
        expect(i18n.t('service.whatsapp.connected')).toContain('Connecté');
    });

    it('ignores an empty value after the = separator and keeps the default locale', async () => {
        process.argv = ['node', 'pi', '--whatsapp-pi-locale='];
        const i18n = await load();
        i18n.initI18n({});
        // Empty override -> default (en).
        expect(i18n.t('service.whatsapp.connected')).toBe('| WhatsApp: Connected');
    });

    it('keeps English when no override is present', async () => {
        process.argv = ['node', 'pi'];
        const i18n = await load();
        i18n.initI18n({});
        expect(i18n.t('service.whatsapp.connected')).toBe('| WhatsApp: Connected');
    });
});
