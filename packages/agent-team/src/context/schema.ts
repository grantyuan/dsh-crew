/**
 * Physical schema for the derived context index.
 *
 * This database is separate from the Team ledger on purpose: it is rebuildable
 * from Session events, holds no authority, and may be deleted at any time. One
 * file per Host keeps WAL and vacuum costs off the ledger database.
 *
 * FTS5 is created best-effort. A SQLite build without the extension leaves
 * {@link ContextFtsCapabilities} false and callers fall back to `LIKE`; unit
 * writes never depend on the virtual tables existing.
 * @module @grantyuan/dsh-crew/context/schema
 */

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** On-disk layout version stored in `PRAGMA user_version`. */
export const CONTEXT_SCHEMA_VERSION = 4

/** Which FTS tokenizers this SQLite build accepted. */
export interface ContextFtsCapabilities {
  readonly word: boolean
  readonly trigram: boolean
}

/** An opened context database with its actual FTS capabilities. */
export interface OpenedContextDatabase {
  readonly db: DatabaseSync
  readonly fts: ContextFtsCapabilities
}

export interface OpenContextDatabaseOptions {
  /** Skip FTS creation; used by tests that exercise the `LIKE` fallback. */
  readonly disableFts?: boolean
}

/** Create a missing file owner-only; existing files keep their mode. */
function ensureDatabaseFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS unit (
  unit_id      TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  importance   INTEGER NOT NULL,
  text         TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  chars        INTEGER NOT NULL,
  recorded_at  TEXT NOT NULL,
  timezone     TEXT,
  event_type   TEXT,
  tool_name    TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(member_id, session_id, seq)
) STRICT;
CREATE INDEX IF NOT EXISTS unit_member_seq ON unit(member_id, session_id, seq);
CREATE INDEX IF NOT EXISTS unit_member_time ON unit(member_id, recorded_at);

CREATE TABLE IF NOT EXISTS term (
  owner_kind TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  term       TEXT NOT NULL,
  term_kind  TEXT NOT NULL,
  weight     REAL NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, term_kind, term)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS term_lookup ON term(term, term_kind);

CREATE TABLE IF NOT EXISTS facet (
  owner_kind  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  value       TEXT NOT NULL,
  raw         TEXT,
  start_ms    INTEGER,
  end_ms      INTEGER,
  granularity TEXT,
  tz          TEXT,
  confidence  REAL NOT NULL,
  source      TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, dimension, value)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS facet_time ON facet(dimension, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS facet_value ON facet(dimension, value);

CREATE TABLE IF NOT EXISTS recall_state (
  member_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, session_id, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  unit_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  last_error   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(kind, available_at);

CREATE TABLE IF NOT EXISTS vector (
  owner_kind TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS memory_node (
  node_id      TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  level        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  ref          TEXT NOT NULL,
  status       TEXT NOT NULL,
  confidence   REAL NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  superseded_by TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS memory_node_member_ref ON memory_node(member_id, ref);
CREATE INDEX IF NOT EXISTS memory_node_member_status ON memory_node(member_id, status);
CREATE INDEX IF NOT EXISTS memory_node_member_level ON memory_node(member_id, level);
CREATE INDEX IF NOT EXISTS memory_node_superseded_by ON memory_node(superseded_by);

CREATE TABLE IF NOT EXISTS memory_edge (
  member_id  TEXT NOT NULL,
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, src_id, dst_id, kind)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_edge_src ON memory_edge(member_id, src_id);
CREATE INDEX IF NOT EXISTS memory_edge_dst ON memory_edge(member_id, dst_id);

CREATE TABLE IF NOT EXISTS context_segment (
  segment_id   TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  level        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  frontier_seq INTEGER NOT NULL,
  digest_json  TEXT NOT NULL,
  digest_hash  TEXT NOT NULL,
  status       TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(member_id, session_id, to_seq)
) STRICT;
CREATE INDEX IF NOT EXISTS context_segment_frontier ON context_segment(member_id, session_id, from_seq, to_seq);

CREATE TABLE IF NOT EXISTS context_epoch (
  member_id        TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  frontier_seq     INTEGER NOT NULL,
  pending_json     TEXT,
  pending_hash     TEXT,
  pending_from_seq INTEGER,
  pending_to_seq   INTEGER,
  pending_at       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (member_id, session_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS context_commitment (
  commitment_id TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  segment_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  quote_hash    TEXT NOT NULL,
  ref           TEXT NOT NULL,
  status        TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS context_commitment_segment ON context_commitment(segment_id);
CREATE INDEX IF NOT EXISTS context_commitment_member ON context_commitment(member_id, session_id);
`

/** Additive migration from the P1.1 layout; safe to re-run. */
const MIGRATE_1_TO_2 = `
CREATE TABLE IF NOT EXISTS vector (
  owner_kind TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
) STRICT, WITHOUT ROWID;
`

/** Additive migration from the P1.2 layout; graph nodes and edges only. */
const MIGRATE_2_TO_3 = `
CREATE TABLE IF NOT EXISTS memory_node (
  node_id      TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  level        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  ref          TEXT NOT NULL,
  status       TEXT NOT NULL,
  confidence   REAL NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  superseded_by TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS memory_node_member_ref ON memory_node(member_id, ref);
CREATE INDEX IF NOT EXISTS memory_node_member_status ON memory_node(member_id, status);
CREATE INDEX IF NOT EXISTS memory_node_member_level ON memory_node(member_id, level);
CREATE INDEX IF NOT EXISTS memory_node_superseded_by ON memory_node(superseded_by);

CREATE TABLE IF NOT EXISTS memory_edge (
  member_id  TEXT NOT NULL,
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, src_id, dst_id, kind)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_edge_src ON memory_edge(member_id, src_id);
CREATE INDEX IF NOT EXISTS memory_edge_dst ON memory_edge(member_id, dst_id);
`

/** Additive migration from the P1.3 layout; compaction segments and epoch state. */
const MIGRATE_3_TO_4 = `
CREATE TABLE IF NOT EXISTS context_segment (
  segment_id   TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  level        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  frontier_seq INTEGER NOT NULL,
  digest_json  TEXT NOT NULL,
  digest_hash  TEXT NOT NULL,
  status       TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(member_id, session_id, to_seq)
) STRICT;
CREATE INDEX IF NOT EXISTS context_segment_frontier ON context_segment(member_id, session_id, from_seq, to_seq);

CREATE TABLE IF NOT EXISTS context_epoch (
  member_id        TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  frontier_seq     INTEGER NOT NULL,
  pending_json     TEXT,
  pending_hash     TEXT,
  pending_from_seq INTEGER,
  pending_to_seq   INTEGER,
  pending_at       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (member_id, session_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS context_commitment (
  commitment_id TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  segment_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  quote_hash    TEXT NOT NULL,
  ref           TEXT NOT NULL,
  status        TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS context_commitment_segment ON context_commitment(segment_id);
CREATE INDEX IF NOT EXISTS context_commitment_member ON context_commitment(member_id, session_id);
`

const FTS_WORD = "CREATE VIRTUAL TABLE IF NOT EXISTS unit_fts USING fts5(unit_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"
const FTS_TRIGRAM = "CREATE VIRTUAL TABLE IF NOT EXISTS unit_fts_trigram USING fts5(unit_id UNINDEXED, body, tokenize='trigram')"

/**
 * Open (or create) one context database.
 *
 * Zero `user_version` is stamped with {@link CONTEXT_SCHEMA_VERSION} only after
 * the whole layout exists; known older versions (1–3) are upgraded additively,
 * and any other version rejects instead of migrating a derivative that can
 * simply be rebuilt.
 */
export function openContextDatabase(path: string, options: OpenContextDatabaseOptions = {}): OpenedContextDatabase {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') ensureDatabaseFile(actual)

  const db = new DatabaseSync(actual)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    if (actual !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')

    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const onDisk = row?.user_version ?? 0
    if (onDisk !== 0 && onDisk !== 1 && onDisk !== 2 && onDisk !== 3 && onDisk !== CONTEXT_SCHEMA_VERSION) {
      throw new Error(`context database at "${actual}" has schema version ${onDisk}, incompatible with this build (${CONTEXT_SCHEMA_VERSION})`)
    }

    db.exec(CORE_SCHEMA)
    if (onDisk === 1) db.exec(MIGRATE_1_TO_2)
    if (onDisk === 1 || onDisk === 2) db.exec(MIGRATE_2_TO_3)
    if (onDisk !== 0 && onDisk !== CONTEXT_SCHEMA_VERSION) db.exec(MIGRATE_3_TO_4)

    let word = false
    let trigram = false
    if (options.disableFts !== true) {
      try {
        db.exec(FTS_WORD)
        word = true
      } catch {
        word = false
      }
      try {
        db.exec(FTS_TRIGRAM)
        trigram = true
      } catch {
        trigram = false
      }
    }

    if (onDisk !== CONTEXT_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${CONTEXT_SCHEMA_VERSION}`)
    return { db, fts: { word, trigram } }
  } catch (error) {
    db.close()
    throw error
  }
}
