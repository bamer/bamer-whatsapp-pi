# Blueprint: Test Coverage ~100% for bamer-whatsapp-pi

**Objective**: Bring test coverage from ~69% to ~100% on 4 low-coverage files.

**Current Status**: 231/231 tests pass. Coverage: 69.05% statements, 56.07% branches, 72.47% funcs, 69.86% lines.

---

## Phase 1: whatsapp-pi.ts (62% → 100%) — ~200 lines uncovered

**Priority**: High — main entry point, complex logic.

### Uncovered areas (from coverage report):
- `message_end` handler fire-and-forget branches (lines ~1024-1080)
- Command handlers: `/compact`, `/abort`, `/new` (lines ~370-400)
- Auto-connect logic with `shouldStartPolling` (lines ~251-260)
- Session restore: `savedStateEntry` handling (lines ~226-240)
- Session status transitions: `pairing` → `connected` → `disconnected`
- Extension context mode checks (interactive vs passive)
- QR code callback + welcome message sending
- Error paths in `handleConnectionClosed` / `handleConnectionOpen`
- Socket initialization error handling

### Test strategy:
- Add unit tests mocking `pi.on('message_end')` with fire-and-forget
- Test each command handler with proper mocks
- Mock `shouldStartPolling` for interactive vs passive modes
- Test session restore with various status values

---

## Phase 2: menu.handler.ts (47% → 100%) — ~300 lines uncovered

**Priority**: High — main UI interaction layer.

### Uncovered areas:
- Settings handlers: `agentSignature`, `logMaxSizeMB`, `logRetentionDays` (newly added, 0% covered)
- Contact list: filter search (label/value/description), keyboard nav (arrows/Enter/Escape/Backspace), selection → detail
- Recents grouping: `addToUpdateList`, `sendMessage`, `removeAlias`, pagination
- `manageContactDetail`: profile picture fetch, fallback when missing
- `showConversationHistoryForContact`: sorting, pagination, empty state
- `manageRecents`: grouped entries, navigation (Next/Previous)
- Error paths in `sendPromptedMenuMessage` (socket errors, missing recents)
- `formatContactOption` / `formatHistoryOption` edge cases (missing fields)
- `handleCommand` default case (unknown choice)

---

## Phase 3: contacts.service.ts (83% → 100%) — ~50 lines uncovered

**Priority**: Medium — pure service, high ROI.

### Uncovered areas:
- `fetchContactsFromGroups`: empty groups, missing `phoneNumber` on participants, socket errors
- `getProfilePictureUrl`: `imgUrl` null, `profilePictureUrl` throws, `profilePictureUrl` returns undefined
- `reclassifyContacts`: no matches, already all addressbook, mixed sources
- `load()`: file not found, corrupted JSON, permission errors
- `save()`: write errors, mkdir failures
- `scheduleSave()`: timer clearing, rapid successive calls (debounce)
- `getContactsBySource` / `getCountBySource`: empty map, source not matching

---

## Phase 4: searchable-list.ts (0% → 100%) — ~100 lines uncovered

**Priority**: Medium — new component, pure logic.

### Uncovered areas:
- Filter logic: by `label` (name), by `value` (JID), by `description` (phone), case-insensitive
- Keyboard navigation: Up/Down (wrap), Enter (select), Escape (cancel), Backspace (clear filter)
- `onSelect` / `onCancel` callbacks: fired correctly, late assignment support
- `Input` → `SelectList` focus handoff on Enter
- `SelectList` selected index wrap-around (top → bottom, bottom → top)
- `setFilter('')` clears filter → shows all items
- No-match state (empty filtered items)

---

## Execution Order

| Phase | File | Est. Effort | Dependencies |
|-------|------|-------------|--------------|
| 1 | whatsapp-pi.ts | ~4h | None (main entry) |
| 2 | menu.handler.ts | ~6h | None (UI layer) |
| 3 | contacts.service.ts | ~2h | None (pure service) |
| 4 | searchable-list.ts | ~2h | None (UI component) |

**Total**: ~14h — can be split across 4-5 sessions.

---

## Quality Gates

Each phase complete when:
- [ ] New tests written covering all uncovered branches/lines
- [ ] All existing tests still pass (`pnpm test`)
- [ ] Coverage report shows 100% for the file
- [ ] No regression in other files (`pnpm test` full suite)

---

## Notes

- Use `happy-dom` environment for UI components (menu.handler, searchable-list)
- Mock pi-tui properly or test filtering logic in isolation
- For whatsapp-pi.ts, mock `pi` API (`pi.on`, `pi.registerTool`, `pi.sendUserMessage`)
- For menu.handler, mock `ctx.ui` (select, input, notify, custom)
- For contacts.service, mock `fs/promises` and socket (profilePictureUrl)
- For searchable-list, test filtering logic in isolation + real pi-tui integration for keyboard