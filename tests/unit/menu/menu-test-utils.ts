import { vi } from 'vitest';
import type { MenuEnv } from '../../../src/ui/menu/menu-context.js';

export type SelectChoice = string | ((title: string, options: string[]) => string);

export function makeCtx(choices: {
	selects?: SelectChoice[];
	inputs?: (string | undefined)[];
	confirms?: boolean[];
	customResult?: string | null;
} = {}) {
	const selects = [...(choices.selects ?? [])];
	const inputs = [...(choices.inputs ?? [])];
	const confirms = [...(choices.confirms ?? [])];

	return {
		ui: {
			select: vi.fn(async (title: string, options: string[]) => {
				const choice = selects.shift();
				if (typeof choice === 'function') return choice(title, options);
				return choice ?? options[options.length - 1]; // default: last option (usually Back)
			}),
			input: vi.fn(async () => inputs.shift()),
			confirm: vi.fn(async () => confirms.shift() ?? false),
			notify: vi.fn(),
			custom: vi.fn(async (factory: any) => {
				if (!('customResult' in choices)) return undefined;
				let captured: any;
				const done = (v: any) => { captured = v; };
				const component = factory(null, { fg: (_r: string, s: string) => s }, null, done);
				// Simulate immediate selection/cancel via the component callbacks.
				if (choices.customResult === null) component.onCancel?.();
				else if (typeof choices.customResult === 'string') {
					component.onSelect?.({ value: choices.customResult, label: '', description: '' });
				}
				return captured;
			})
		}
	};
}

export function makeEnv(overrides: Record<string, any> = {}): MenuEnv {
	return {
		whatsappService: {
			getContactsService: vi.fn().mockReturnValue({
				getCount: vi.fn().mockReturnValue(0),
				getCountBySource: vi.fn().mockReturnValue(0),
				getContactsBySource: vi.fn().mockReturnValue([]),
				getAllContacts: vi.fn().mockReturnValue([]),
				fetchContactsFromGroups: vi.fn().mockResolvedValue({ groups: 0, contacts: 0 }),
				reclassifyContacts: vi.fn().mockReturnValue({ upgraded: 0, total: 0 })
			}),
			getSocket: vi.fn().mockReturnValue(undefined),
			sendMenuMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'M1' })
		},
		sessionManager: {
			getBrandVisibility: vi.fn().mockReturnValue(true),
			setBrandVisibility: vi.fn().mockResolvedValue(undefined),
			getAutoConnect: vi.fn().mockReturnValue(false),
			setAutoConnect: vi.fn().mockResolvedValue(undefined),
			getAssistantName: vi.fn().mockReturnValue('Agent Pi'),
			setAssistantName: vi.fn().mockResolvedValue(undefined),
			getAgentSignature: vi.fn().mockReturnValue('π'),
			setAgentSignature: vi.fn().mockResolvedValue(undefined),
			getLogMaxSizeMB: vi.fn().mockReturnValue(5),
			setLogMaxSizeMB: vi.fn().mockResolvedValue(undefined),
			getLogRetentionDays: vi.fn().mockReturnValue(7),
			setLogRetentionDays: vi.fn().mockResolvedValue(undefined),
			isAllowedUpdateTarget: vi.fn().mockResolvedValue(false),
			isConversationAllowed: vi.fn().mockReturnValue(true),
			getAllowedContact: vi.fn().mockReturnValue(undefined),
			getAllowedGroup: vi.fn().mockReturnValue(undefined),
			getUpdateList: vi.fn().mockReturnValue([]),
			addUpdateNumber: vi.fn().mockResolvedValue(undefined),
			removeUpdateNumber: vi.fn().mockResolvedValue(undefined),
			getAllowedGroups: vi.fn().mockReturnValue([]),
			addAllowedGroup: vi.fn().mockResolvedValue(undefined),
			removeAllowedGroup: vi.fn().mockResolvedValue(undefined),
			setAllowedGroupAlias: vi.fn().mockResolvedValue(undefined),
			removeAllowedGroupAlias: vi.fn().mockResolvedValue(undefined),
			getAllowList: vi.fn().mockReturnValue([]),
			addNumber: vi.fn().mockResolvedValue(undefined),
			removeNumber: vi.fn().mockResolvedValue(undefined),
			setAllowedContactAlias: vi.fn().mockResolvedValue(undefined),
			removeAllowedContactAlias: vi.fn().mockResolvedValue(undefined),
			setContactSendNumber: vi.fn().mockResolvedValue(undefined),
			removeContactSendNumber: vi.fn().mockResolvedValue(undefined),
			getAgentSignature: vi.fn().mockReturnValue('π'),
			getAssistantName: vi.fn().mockReturnValue('Agent Pi')
		},
		recentsService: {
			getRecentConversations: vi.fn().mockResolvedValue([]),
			getConversationHistory: vi.fn().mockResolvedValue([]),
			recordMessage: vi.fn().mockResolvedValue(undefined)
		},
		openRootMenu: vi.fn().mockResolvedValue(undefined),
		...overrides
	} as unknown as MenuEnv;
}
