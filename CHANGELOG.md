# Changelog

## [1.9.6] - 2025-08-12

### Fixed
- **Contact list search now works**: The search in the contact list now filters by name, phone number, LID, AND the display label. Previously it only matched on the internal JID value which users couldn't know.
- **Enter to open contact detail**: Pressing Enter on a contact in the searchable list now opens the contact detail menu (fetch photo, back). The onSelect callback is now properly wired.

## [1.9.5] - 2025-08-10

### Fixed
- **Logoff when socket disconnected**: Previously, clicking "Logoff & Delete Session" while the socket was already closed threw "Connection Closed" and prevented the auth state from being deleted. Now the socket logout is wrapped in try/catch, and the auth state is always deleted so the user can re-pair with a fresh QR code.

## [1.9.4] - 2025-08-07

### Added
- **Media indicator for outgoing messages**: When Ben sends a photo, video, audio, document, contact, location, or reaction, the header now includes an emoji indicator (📷 Photo, 🎥 Video, 🎤 Audio, 📄 Document, 👤 Contact, 📍 Location, ❤️ Reaction). Previously, outgoing media messages were displayed without any indication of the media type.

## [1.9.3] - 2025-08-03

### Fixed
- **Outgoing message display**: For messages sent by Ben (fromMe=true), the header now shows `Ben sent to Patrice:` instead of `→ Sent to Ben (157831491797218)`. The recipient name is looked up from the contacts service and config lists, not from `msg.pushName` (which is the sender's name, not the recipient's).

## [1.9.2] - 2025-08-03

### Fixed
- **Message direction display**: Outgoing messages (fromMe=true) now show as `→ Sent to` instead of `Message from`, making it clear whether a message was sent or received. Previously, a message Ben sent to Yves appeared as "Message from Ben (79895686287380)" which looked like a message from Yves' number.

## [1.9.1] - 2025-08-01

### Fixed
- **Personal contacts now detected**: `contacts.upsert`/`update` events upgrade a contact's source to `addressbook` when a `name` or `notify` field is present — group participants only have `id`+`phoneNumber`, so named contacts are correctly classified as personal
- **`messaging-history.set` handler**: Fixed `existing` type cast (was `{}` → now `SyncedContact | undefined`)

### Added
- **"Re-classify contacts" settings option**: Scans all contacts and upgrades any with a `name`/`notify` to `addressbook` (personal). Useful after `fetchContactsFromGroups` populated everything as `group`.
- **`ContactsService.reclassifyContacts()`**: Returns `{ upgraded, total }` count

### Note
- For linked devices, WhatsApp does NOT sync the phone's address book via `messaging-history.set`. Personal contacts are detected by the presence of a `name`/`notify` field in `contacts.upsert`/`update` events (which fire for contacts the bot interacts with).

## [1.9.0] - 2025-08-01

### Added
- **Contact source separation**: Contacts are now tagged as `addressbook` (personal) or `group` (group participants), with a filter menu (Personal / Group participants / All) in the Contact List
- **Searchable contact list**: Type to fuzzy-filter contacts in real-time (arrows to navigate, Enter to select, Esc to cancel) — built with `ctx.ui.custom()` + `SelectList.setFilter()` + `Input`
- **`messaging-history.set` event listener**: Syncs the personal address book contacts on connection (not just group participants), tagged as `source: 'addressbook'`
- **`getContactsBySource()` / `getCountBySource()`**: New `ContactsService` methods for filtering by source

### Changed
- Contact List now opens with a filter selection (Personal / Group / All) before showing the searchable list
- `fetchContactsFromGroups` tags contacts with `source: 'group'` instead of mixing them with personal contacts

## [1.8.0] - 2025-08-01

### Added
- **Fetch contacts from groups**: New settings option that manually fetches all contacts from group participants via `groupFetchAllParticipating()` — useful for linked devices that don't receive the full contact list via `contacts.upsert` events
- **`onWhatsApp` API**: Added to `WhatsAppSocketLike` interface for phone number validation
- **`fetchContactsFromGroups` method**: New `ContactsService` method that iterates all groups, stores participants as contacts (with LID + phone number), and returns a summary

### Fixed
- **All `console.log`/`error`/`warn` replaced with `fileLog`**: No more TUI rendering interference — all extension output now goes to `whatsapp-pi.log` via `fileLog()` or `ctx.ui.notify()` per Pi extension API docs
- **`whatsapp-pi.logger.ts`**: Removed `console.error`/`warn` calls that were firing even in non-verbose mode

## [1.7.0] - 2025-08-01

### Added
- **Contact List menu**: New menu entry that syncs WhatsApp contacts in the background via `contacts.upsert`/`contacts.update` events, stores them in `contacts.json`, and fetches profile photos on demand via `sock.profilePictureUrl(jid, 'image')`
- **ContactsService**: New service that listens to contact events, stores contacts in a separate JSON file (debounced save every 2s), and exposes `getAllContacts`/`getContact`/`getProfilePictureUrl`
- **Contact detail view**: Paginated list (20/page) with per-contact details (name, phone, LID, status, ID) and a "Fetch profile photo" button
- **i18n**: EN/FR/PT/ES translations for all new Contact List strings

### Changed
- **WhatsAppSocketLike**: Extended with `profilePictureUrl` method and `contacts.upsert`/`contacts.update` event handlers
- **StoragePaths**: Added `contactsPath` for the new `contacts.json` file

## [1.6.0] - 2025-08-01

### Changed
- **Baileys 6.17.16 → 7.0.0-rc14**: Major version upgrade adding LID (Local Identifier) support — the root cause of the persistent "Waiting for this message" bug in group messaging
- **LID mapping system**: Baileys 7.0+ adds `resolveLIDSignalAddress`, `LIDMappingStore`, `WAMessageAddressingMode`, and USync LID protocol for automatic PN→LID conversion before encryption
- **`@mariozechner/pi-tui` → `@earendil-works/pi-tui`**: Migrated to the new maintained package (v0.83.0)

### Fixed
- **Group "Waiting for this message" bug (ROOT CAUSE)**: Baileys 6.x had no LID mapping system. WhatsApp now uses LID addressing for groups, but v6 sent with PN identity → sender key distribution failed silently for all recipients. Baileys 7.0+ resolves this by converting PN→LID before encryption.
- **Fire-and-forget `send_wa_message`**: All `sendMessage` calls (tool, `message_end` handler, `/compact`, `/abort`) are now non-blocking — agent turn returns immediately
- **`fromMe` messages from linked devices**: Messages sent from linked devices (LID format like `64175502004378@lid`) are now processed correctly instead of being silently dropped
- **Phone number normalization**: `isAllowed`, `getAllowedContact`, and `isAllowedUpdateTarget` now normalize `+` prefix before comparison, fixing LID JID matching against allowList/updateList
- **`isAllowedUpdateTarget` not awaited**: Async method was not awaited in `fromMe` check, causing `isUpdateTarget` to be a Promise object (always truthy) instead of boolean
- **Full JID passed to `isAllowedUpdateTarget`**: Group JIDs (e.g. `120363409409770410@g.us`) are now matched correctly in updateList
- **Unified file logging**: All debug logs (including `console.log` in `whatsapp.service.ts`) now go to the same `whatsapp-pi.log` file via `fileLog()`

## [1.5.0] - 2025-08-01

### Added
- **Media handling**: Save received images/videos to `whatsapp-medias/{image,video}/` with proper subdirectories
- **Video processing**: Incoming video messages now processed and saved (was previously treated as text)
- **`send_wa_media` tool**: Send images, videos, or documents to WhatsApp contacts/groups with optional caption
- **`add_wa_group_participant` tool**: Add one or more participants to a WhatsApp group by phone number or JID
- **`remove_wa_group_participant` tool**: Remove participants from a WhatsApp group
- **Group metadata cache TTL**: Cache now expires after 5 minutes, preventing stale participant lists
- **Force refresh on group send**: Every group message forces fresh metadata fetch via `prepareGroupSession(jid, true)`

### Fixed
- **Group metadata cache never expired**: Once cached with wrong participant count, it stayed stale forever
- **Group messages sent to wrong recipients**: Bot was sending to itself (1 participant) instead of actual group members
- **`senderMessageKeys` corruption**: Added stale sender key cleanup
- **Baileys debug noise**: Suppressed "Removing old closed session" messages

## [1.4.0] - 2025-07-31

### Added
- **Interactive mode check for auto-connect**: Extension now only auto-connects on Pi startup when running in interactive mode (matches Telegram extension behavior)
- **Message end handler restriction**: Auto-reply now only triggers for contacts in `updateList`, preventing assistant messages from being sent to random WhatsApp contacts
- **Prepare script**: Added `prepare: "pnpm install"` to package.json for automatic dependency installation on `pi update --extensions`

### Changed
- **Auto-connect behavior**: Now checks `canStartPollingInExtensionContext(ctx)` before auto-connecting, skipping in passive modes (`json`, `print`, `rpc`)
- **Message end handler**: Only auto-replies to contacts in `updateList` (previously replied to all contacts with `lastRemoteJid`)
- **Auto-install dependencies**: `prepare` script runs `pnpm install` automatically after `pi update --extensions`

### Fixed
- **Critical bug**: Assistant messages in Pi chat were being sent to last WhatsApp contact (`lastRemoteJid`) via `message_end` handler
- **Auto-connect in passive modes**: Extension no longer attempts WhatsApp connection in `pi --json`, `pi --print`, or `pi --rpc` modes

## [1.3.0] - 2025-07-31

### Added
- **Logger refactoring**: All extension logging now goes through `WhatsAppPiLogger` with configurable file rotation
- **MessageSender logging**: Uses logger instead of console (via WhatsAppService.getLogger())
- **AudioService logging**: Uses logger instead of direct file writes (logger injected at startup)
- **stderr-only logging**: All `console.error` calls in logger, stdout kept clean for `pi spawn`/`pi run`
- **Live config updates**: Logger settings (max size, retention) can be changed at runtime via settings menu

### Changed
- **Logger constructor**: Accepts max size (MB) and retention (days) from config (defaults: 5MB, 7d)
- **Log rotation**: New file at configured size (0=disabled, max 20MB)
- **Log cleanup**: Removes files older than retention (0=disabled, max 365d), max 10 files
- **Log format**: `[ISO-timestamp] [LEVEL] message args...` in timestamped files `whatsapp-pi-<timestamp>.log`
- **Logger methods**: `info()`, `log()`, `warn()`, `error()` all use `console.error` (stderr)

### Fixed
- **stdout pollution**: Server reading stdout from `pi spawn` no longer receives WhatsApp-Pi logs
- **MessageSender**: Replaced `console.error`/`console.log` with logger
- **AudioService**: Replaced direct file writes with injected logger
- **Logger import**: Fixed missing imports in services

## [1.2.0] - 2025-07-31

### Added
- **Log Settings submenu**: Configure max log file size (0=disabled, max 20MB) and retention (0=disabled, max 365 days) via `/whatsapp > Settings > Log Settings`
- **Logger rotation & cleanup**: Automatic rotation at configured size, cleanup of logs older than configured retention, max 10 files retained
- **Configurable logger**: Logger settings applied at startup, dynamically updatable via settings menu
- **stderr-only logging**: All logger output goes to stderr, keeping stdout clean for `pi spawn`/`pi run` result parsing
- **Voice transcription patch**: 🎤 icon on transcribed audio, π: prefix on bot replies (re-applied after npm update)

### Changed
- **Logger constructor**: Now accepts max size and retention from config (defaults: 5MB, 7 days)
- **Logger methods**: `info()`, `log()`, `warn()`, `error()` all use `console.error` (stderr)
- **Log file naming**: Timestamped files `whatsapp-pi-<ISO-timestamp>.log`
- **Voice transcription format**: Now shows `🎤 {transcription}` instead of bare text

### Fixed
- **Log pollution**: Server reading stdout from `pi spawn` no longer receives WhatsApp-Pi logs
- **Duplicate config keys**: Removed duplicate `logMaxSizeMB`/`logRetentionDays` entries in SessionManager
- **Logger import**: Fixed missing `WhatsAppPiLogger` import in `WhatsAppService`

## [1.1.0] - 2025-07-30

### Added
- **Operator message recognition**: Messages from the operator now show `[Operator]` prefix to distinguish from contact messages
- **Update list**: Configurable list of contacts/numbers that can receive proactive messages from the agent
- **Update list menu**: Settings menu for managing update targets (add, remove, alias)
- **Auto-connect setting**: Option in settings menu to auto-connect on Pi startup
- **Assistant name setting**: Configurable name for the agent (default: "Agent Pi")
- **Agent signature setting**: Configurable signature appended to outgoing messages (default: "π", empty = none)
- **History display**: Outgoing messages now show assistant name instead of "Sent"
- **Message detail view**: Direction field shows assistant name for outgoing messages
- **Voice transcription patch**: Simplified transcription output format

### Changed
- **Message filtering**: Added `fromMe` filter to prevent processing operator's own messages to contacts
- **Signature logic**: `isPiGeneratedMessage` now uses configurable signature instead of hardcoded 'π'
- **Menu sends**: Outgoing messages use configurable signature instead of hardcoded 'π'

### Fixed
- **Message attribution**: Operator messages to contacts no longer appear as incoming messages to the agent
- **Audio service**: Updated constructor to work with patched version (no logger parameter)

## [1.0.69] - Previous release

### Added
- Initial implementation of update list management
- Auto-connect feature
- Assistant name management
- Settings brand visibility toggle

---

*This changelog was auto-generated based on commit history.*
