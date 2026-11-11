/**
 * Language helpers for per-contact language hints.
 *
 * Codes follow ISO 639-1 (`lo`, `en`, `fr`...). A stored value may list
 * several languages in priority order, e.g. `lo,en`.
 */

const SCRIPT_RANGES: Array<{ language: string; range: RegExp }> = [
	{ language: "lo", range: /[\u0E80-\u0EFF]/ },
	{ language: "th", range: /[\u0E00-\u0E7F]/ },
	{ language: "ar", range: /[\u0600-\u06FF]/ },
	{ language: "ru", range: /[\u0400-\u04FF]/ },
	{ language: "zh", range: /[\u4E00-\u9FFF]/ },
	{ language: "ko", range: /[\uAC00-\uD7AF]/ },
	{ language: "ja", range: /[\u3040-\u30FF]/ },
];

const LANGUAGE_NAMES: Record<string, string> = {
	lo: "Lao",
	en: "English",
	fr: "French",
	th: "Thai",
	de: "German",
	es: "Spanish",
	it: "Italian",
	pt: "Portuguese",
	ru: "Russian",
	zh: "Chinese",
	ja: "Japanese",
	ko: "Korean",
	ar: "Arabic",
	vi: "Vietnamese",
};

/** Detect a language from non-Latin scripts (Latin is ambiguous → undefined). */
export function detectLanguage(text: string | undefined): string | undefined {
	if (!text) return undefined;
	for (const { language, range } of SCRIPT_RANGES) {
		if (range.test(text)) return language;
	}
	return undefined;
}

/** Normalize a stored languages value: `lo,en` → `lo,en`, junk dropped. */
export function normalizeLanguages(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase().replace(/\s+/g, "");
	if (!trimmed) return undefined;
	const codes = trimmed
		.split(",")
		.map((code) => code.replace(/[^a-z]/g, ""))
		.filter((code) => code.length === 2);
	return codes.length > 0 ? codes.join(",") : undefined;
}

/** `lo,en` → `Lao, English` (unknown codes are capitalized). */
export function formatLanguages(value: string | undefined): string | undefined {
	const normalized = normalizeLanguages(value);
	if (!normalized) return undefined;
	return normalized
		.split(",")
		.map((code) => LANGUAGE_NAMES[code] ?? code.toUpperCase())
		.join(", ");
}

/**
 * Languages to display for an incoming message: the stored per-contact hint
 * wins; otherwise fall back to script detection on the message text.
 */
export function resolveContactLanguages(
	stored: string | undefined,
	messageText: string | undefined,
): string | undefined {
	return formatLanguages(stored) ?? formatLanguages(detectLanguage(messageText));
}
