# con[VER]sum Changelog

## Unreleased

### Added

### Changed

### Fixed

### Removed

____
## 1.1.7 - 2026-10-26

### Added

- Import and export compiled databases, so a mobile device can reuse an index built on desktop instead of rebuilding it.
- Database validation before an imported index replaces the current one.
- Startup logging of reference, occurrence, and file counts, plus a warning when the index looks incomplete.
- Database verification after a rebuild and periodic checkpoint logging.

### Fixed

- Fixed index occurrences being deleted during updates by replacing `INSERT OR REPLACE` on `file_index` with a true UPSERT.
- Fixed foreign keys being silently disabled after `sql.js` exports the database.
- Improved database save reliability with atomic writes and recovery from corrupted database files.
- Reduced WASM parse chunk size and yielded more often to improve reliability on mobile.

____
## 1.1.0 - 2026-08-01
### Fixed

- Fixed Settings panel in dark mode
- Fixed source language override

## 1.0.1 - 2026-07-31

### Changed

- Minor cosmetic tweaks

## 1.0.0 - 2026-07-31

- Initial Obsidian Community release

## 0.1.5 - 2026-07-31

### Changed

- Fixed some Obsidian linter warnings

## 0.1.0 - 2026-07-30

- Initial *beta* release

____
[1.1.7]:https://github.com/erykjj/conversum/releases/tag/1.1.7
[1.1.0]:https://github.com/erykjj/conversum/releases/tag/1.1.0
[1.0.1]:https://github.com/erykjj/conversum/releases/tag/1.0.1
[1.0.0]:https://github.com/erykjj/conversum/releases/tag/1.0.0
[0.1.5]:https://github.com/erykjj/conversum/releases/tag/0.1.5
[0.1.0]:https://github.com/erykjj/conversum/releases/tag/0.1.0
