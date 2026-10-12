export const ROUTINE_WATCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_routine_watches (
 watch_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 routine_id TEXT NOT NULL,
 gateway_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 sender_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 after_rowid INTEGER NOT NULL,
 deadline INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('waiting','matched','running','completed','cancelled','timed-out','blocked')),
 event_id TEXT,
 run_id TEXT
);
`;
