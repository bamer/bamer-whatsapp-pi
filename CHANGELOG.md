# Changelog

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
