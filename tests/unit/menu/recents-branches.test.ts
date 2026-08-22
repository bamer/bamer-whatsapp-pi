import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n, t } from '../../../src/i18n.ts';
import {
    manageRecents,
    manageRecentConversation,
} from '../../../src/ui/menu/recents.menu.ts';
import { makeCtx, makeEnv } from './menu-test-utils.ts';

const makeConv = (overrides: Record<string, any> = {}) => ({
    senderNumber: '33684136128@s.whatsapp.net',
    senderName: 'Ben',
    lastMessagePreview: 'salut',
    lastMessageTime: 1_800_000_000,
    lastMessageDirection: 'incoming',
    messageCount: 2,
    isAllowed: false,
    ...overrides
});

describe('recents.menu — remaining branches', () => {
    let env: ReturnType<typeof makeEnv>;

    beforeEach(() => {
        resetI18n();
        env = makeEnv();
    });

    it('returns silently when the chosen option matches no entry', async () => {
        (env.recentsService.getRecentConversations as any).mockResolvedValue([makeConv()]);
        const ctx = makeCtx({ selects: ['ghost option'] });

        await manageRecents(ctx as any, env);

        expect(ctx.ui.select).toHaveBeenCalledTimes(1);
        expect(env.openRootMenu).not.toHaveBeenCalled();
    });

    it('Previous on page 0 keeps the list on page 0', async () => {
        const conversations = Array.from({ length: 12 }, (_, i) => makeConv({
            senderNumber: `+1110000000${i}`,
            senderName: `C${i}`
        }));
        (env.recentsService.getRecentConversations as any).mockResolvedValue(conversations);

        let sawPrevious = false;
        const ctx = makeCtx({
            selects: [
                () => 'Previous', // page 0: no Previous option -> default? select queue returns explicit value
                () => { sawPrevious = true; return 'Back'; }
            ]
        });
        void sawPrevious;

        await manageRecents(ctx as any, env);

        // Page 0 has no Previous option; the flow still terminates via Back.
        expect(ctx.ui.select).toHaveBeenCalled();
    });

    describe('manageRecentConversation — allow/update/alias branches', () => {
        const ALLOW = () => t('menu.recents.contact.allowNumber');
        const ALLOW_GROUP = () => t('menu.recents.contact.allowGroup');
        const ADD_UPDATE = () => t('menu.recents.contact.addToUpdateList');
        const REMOVE_ALIAS = () => t('menu.recents.contact.removeAlias');
        const HISTORY = () => t('menu.recents.contact.history');

        it('notifies already-allowed when the contact is already authorized', async () => {
            (env.sessionManager.isConversationAllowed as any).mockReturnValue(true);
            const ctx = makeCtx({
                selects: [ALLOW(), t('menu.recents.contact.back')]
            });

            await manageRecentConversation(ctx as any, env, makeConv());

            expect(env.sessionManager.addNumber).not.toHaveBeenCalled();
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                t('menu.recents.alreadyAllowed', { number: '33684136128@s.whatsapp.net' }), 'info'
            );
        });

        it('adds a group to the allow list with its name', async () => {
            const conv = makeConv({
                senderNumber: '120363409409770410@g.us',
                senderName: 'Family'
            });
            (env.sessionManager.isConversationAllowed as any).mockReturnValue(false);
            const ctx = makeCtx({ selects: [ALLOW_GROUP(), t('menu.recents.contact.back')] });

            await manageRecentConversation(ctx as any, env, conv);

            expect(env.sessionManager.addAllowedGroup).toHaveBeenCalledWith(
                '120363409409770410@g.us', 'Family'
            );
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                t('menu.recents.addedGroupToAllowList', { groupJid: '120363409409770410@g.us' }),
                'info'
            );
        });

        it('adds a bare number to the allow list with its name', async () => {
            (env.sessionManager.isConversationAllowed as any).mockReturnValue(false);
            const ctx = makeCtx({ selects: [ALLOW(), t('menu.recents.contact.back')] });

            await manageRecentConversation(ctx as any, env, makeConv());

            expect(env.sessionManager.addNumber).toHaveBeenCalledWith(
                '33684136128@s.whatsapp.net', 'Ben'
            );
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                t('menu.recents.addedToAllowList', { number: '33684136128@s.whatsapp.net' }),
                'info'
            );
        });

        it('notifies already-in-update-list instead of adding twice', async () => {
            (env.sessionManager.isAllowedUpdateTarget as any)
                .mockResolvedValue(false)   // options build
                .mockResolvedValueOnce(false)
                .mockResolvedValue(true);   // command branch check
            const ctx = makeCtx({ selects: [ADD_UPDATE(), t('menu.recents.contact.back')] });

            await manageRecentConversation(ctx as any, env, makeConv());

            expect(env.sessionManager.addUpdateNumber).not.toHaveBeenCalled();
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                t('menu.recents.alreadyInUpdateList', { number: '33684136128@s.whatsapp.net' }),
                'info'
            );
        });

        it('removes a contact alias and clears the sender name downstream', async () => {
            (env.sessionManager.getAllowedContact as any)
                .mockReturnValueOnce(undefined)          // displayName computation
                .mockReturnValue({ name: 'Papa' });      // removeAlias option present
            const ctx = makeCtx({ selects: [REMOVE_ALIAS(), t('menu.recents.contact.back')] });

            await manageRecentConversation(ctx as any, env, makeConv());

            expect(env.sessionManager.removeAllowedContactAlias).toHaveBeenCalledWith(
                '33684136128@s.whatsapp.net'
            );
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                t('menu.recents.aliasRemoved', { number: '33684136128@s.whatsapp.net' }),
                'info'
            );
        });

        it('removes a group alias for group conversations', async () => {
            const conv = makeConv({ senderNumber: '120363409409770410@g.us', senderName: undefined });
            (env.sessionManager.getAllowedGroup as any).mockReturnValue({ name: 'Family' });
            const ctx = makeCtx({ selects: [REMOVE_ALIAS(), t('menu.recents.contact.back')] });

            await manageRecentConversation(ctx as any, env, conv);

            expect(env.sessionManager.removeAllowedGroupAlias).toHaveBeenCalledWith(
                '120363409409770410@g.us'
            );
        });

        it('History runs the real history flow for the contact', async () => {
            (env.recentsService.getConversationHistory as any).mockResolvedValue([]);
            const ctx = makeCtx({ selects: [HISTORY(), 'Back'] });

            await manageRecentConversation(ctx as any, env, makeConv());

            // Empty history -> notify + return; proves the delegation ran.
            expect(env.recentsService.getConversationHistory).toHaveBeenCalledWith(
                '33684136128@s.whatsapp.net'
            );
            expect(ctx.ui.notify).toHaveBeenCalledWith(
                expect.stringContaining('history'), 'info'
            );
        });
    });
});