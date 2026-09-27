# Credits

External projects this codebase draws on, and exactly what was taken from
each - see [AUTHORS.md](AUTHORS.md) for the people behind MCLite itself.

## SQLite

Naming and conceptual inspiration, not code: MCLite's `query.js`
(`WHERE`-equivalent filtering), `vacuum.js` (`VACUUM` - re-serializing
records and finalizing buffered writes), `attach.js` (`ATTACH` - joining a
pair relationship with both sides' actual records in one call), and
`maintenance.js`'s structured per-check pass/fail tally (`PRAGMA
integrity_check`) are all named and modeled after SQLite's real behavior,
scoped honestly to what a flat key-value dynamic-property store can
actually offer - no B-tree, no WAL file, no query planner or virtual
tables. See `README.md`'s own SQLite-concept mapping table and non-goals
section for the full, honest accounting of what maps and what doesn't.

## Fedora Silverblue / OSTree

`recordStore.js`'s atomic write pattern is modeled directly on how
Silverblue's OSTree actually applies a system update: a complete new
generation is fully built and validated first, committed as its own
independent "deployment," and only then does a single pointer switch over
to it - the previous deployment stays fully intact, so rollback is
"point back at it," not a reconstruction. `pin()`/`unpin()`/`rollback()`/
`status()` mirror OSTree's own `pin`, `rollback`, and `admin status`
verbs by name and by behavior.
