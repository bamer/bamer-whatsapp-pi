import { describe, expect, it } from 'vitest';
import {
	detectLanguage,
	formatLanguages,
	normalizeLanguages,
	resolveContactLanguages
} from '../../src/services/language.helper.ts';

describe('language.helper', () => {
	it('detects Lao, Thai and other non-Latin scripts', () => {
		expect(detectLanguage('ສະບາຍດີ')).toBe('lo');
		expect(detectLanguage('สวัสดี')).toBe('th');
		expect(detectLanguage('مرحبا')).toBe('ar');
		expect(detectLanguage('hello')).toBeUndefined();
		expect(detectLanguage('Ok')).toBeUndefined();
		expect(detectLanguage('')).toBeUndefined();
		expect(detectLanguage(undefined)).toBeUndefined();
	});

	it('normalizes stored language lists (priority order kept)', () => {
		expect(normalizeLanguages(' lo , EN ')).toBe('lo,en');
		expect(normalizeLanguages('lao')).toBeUndefined();
		expect(normalizeLanguages('')).toBeUndefined();
		expect(normalizeLanguages(undefined)).toBeUndefined();
	});

	it('formats codes as human names', () => {
		expect(formatLanguages('lo,en')).toBe('Lao, English');
		expect(formatLanguages('fr')).toBe('French');
		expect(formatLanguages('xx')).toBe('XX');
		expect(formatLanguages(undefined)).toBeUndefined();
	});

	it('stored hint wins over script detection', () => {
		expect(resolveContactLanguages('lo,en', 'hello')).toBe('Lao, English');
		expect(resolveContactLanguages(undefined, 'ສະບາຍດີ')).toBe('Lao');
		expect(resolveContactLanguages(undefined, 'hello')).toBeUndefined();
	});
});
