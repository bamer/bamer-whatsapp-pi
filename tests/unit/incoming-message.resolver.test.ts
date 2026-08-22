import { beforeEach, describe, expect, it } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';
import { extractIncomingText } from '../../src/services/incoming-message.resolver.ts';

describe('extractIncomingText', () => {
    beforeEach(() => {
        resetI18n();
    });

    it('extracts plain conversation text', () => {
        expect(extractIncomingText({ conversation: 'hello' })).toEqual({
            kind: 'text',
            text: 'hello'
        });
    });

    it('extracts extended text messages', () => {
        expect(extractIncomingText({ extendedTextMessage: { text: 'extended hello' } })).toEqual({
            kind: 'text',
            text: 'extended hello'
        });
    });

    it('resolves image messages with captions', () => {
        const imageMessage = { caption: 'look', mimetype: 'image/jpeg' };

        expect(extractIncomingText({ imageMessage })).toEqual({
            kind: 'image',
            text: 'look',
            imageMessage
        });
    });

    it('unwraps ephemeral message content', () => {
        expect(extractIncomingText({
            ephemeralMessage: {
                message: {
                    conversation: 'hidden'
                }
            }
        })).toEqual({
            kind: 'text',
            text: 'hidden'
        });
    });

    it('formats protocol messages as system messages', () => {
        expect(extractIncomingText({ protocolMessage: { type: 0 } })).toEqual({
            kind: 'system',
            text: '[Message Deleted]'
        });
    });

    it('extracts reaction messages with emoji', () => {
        const reactionMessage = { text: '👍', key: { remoteJid: '123@s.whatsapp.net', id: 'msg123', fromMe: false } };
        expect(extractIncomingText({ reactionMessage })).toEqual({
            kind: 'reaction',
            text: '👍 Reacted to message',
            reactionMessage
        });
    });

    it('handles removed reactions', () => {
        const reactionMessage = { text: '', key: { remoteJid: '123@s.whatsapp.net', id: 'msg123', fromMe: false } };
        expect(extractIncomingText({ reactionMessage })).toEqual({
            kind: 'reaction',
            text: 'Removed reaction',
            reactionMessage
        });
    });

    it('resolves video messages with and without captions', () => {
        const videoMessage = { caption: 'clip', mimetype: 'video/mp4' };
        expect(extractIncomingText({ videoMessage }).kind).toBe('video');
        expect(extractIncomingText({ videoMessage: { mimetype: 'video/webm' } }).text)
            .toContain('Video');
    });

    it('resolves audio messages', () => {
        const audioMessage = { seconds: 3 };
        const result = extractIncomingText({ audioMessage });
        expect(result.kind).toBe('audio');
        if (result.kind === 'audio') expect(result.audioMessage).toBe(audioMessage);
    });

    it('resolves document messages with fallback text', () => {
        const documentMessage = { fileName: 'a.pdf' };
        expect(extractIncomingText({ documentMessage: { caption: 'doc', ...documentMessage } }).kind).toBe('document');
        expect(extractIncomingText({ documentMessage }).text).toContain('[Document');
    });

    it('resolves contact and location messages', () => {
        expect(extractIncomingText({ contactMessage: { displayName: 'X' } }).kind).toBe('contact');
        expect(extractIncomingText({ contactsArrayMessage: { contacts: [] } }).kind).toBe('contact');
        expect(extractIncomingText({ locationMessage: { degreesLatitude: 1 } }).kind).toBe('location');
    });

    it('resolves interactive responses (buttons, lists, template buttons)', () => {
        expect(extractIncomingText({ buttonsResponseMessage: { selectedDisplayText: 'Yes please' } })).toEqual({
            kind: 'text',
            text: 'Yes please'
        });
        expect(extractIncomingText({ listResponseMessage: { title: 'Option 2' } })).toEqual({
            kind: 'text',
            text: 'Option 2'
        });
        expect(extractIncomingText({ templateButtonReplyMessage: { selectedDisplayText: 'Go' } })).toEqual({
            kind: 'text',
            text: 'Go'
        });
    });

    it('formats protocol messages including edited message text', () => {
        // Edited message carrying the new conversation text.
        const edited = extractIncomingText({
            protocolMessage: { type: 14, editedMessage: { conversation: 'new text' } }
        });
        expect(edited.kind).toBe('system');
        expect(edited.text).toContain('new text');

        // Unknown protocol type falls back to the system-update label.
        const unknownType = extractIncomingText({ protocolMessage: { type: 99 } });
        expect(unknownType.kind).toBe('system');
    });

    it('falls back to unsupported for unrecognized or empty payloads', () => {
        const result = extractIncomingText({ someFutureMessageType: {} });
        expect(result.kind).toBe('unsupported');
        expect(result.text).toContain('someFutureMessageType');

        expect(extractIncomingText(null).kind).toBe('unsupported');
        expect(extractIncomingText(undefined).kind).toBe('unsupported');
    });

    it('reports reaction removal when the emoji is empty', () => {
        const result = extractIncomingText({ reactionMessage: { text: '', key: {} } });
        expect(result.kind).toBe('reaction');
    });
});
