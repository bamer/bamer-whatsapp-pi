# Changelog

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
