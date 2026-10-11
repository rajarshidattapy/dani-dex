// Gateway state shares the product database. It is transport state, not a second task system.
export const GATEWAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_gateways (
 gateway_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('telegram','whatsapp','slack')),
 account_id TEXT NOT NULL,
 credential_handle TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 generation INTEGER NOT NULL DEFAULT 1,
 update_offset INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner_id, platform, account_id)
);
CREATE TABLE IF NOT EXISTS projection_gateway_chats (
 gateway_id TEXT NOT NULL REFERENCES projection_gateways(gateway_id),
 conversation_id TEXT NOT NULL,
 sender_id TEXT NOT NULL,
 PRIMARY KEY(gateway_id,conversation_id,sender_id)
);
CREATE TABLE IF NOT EXISTS projection_gateway_inbox (
 gateway_id TEXT NOT NULL REFERENCES projection_gateways(gateway_id),
 event_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 conversation_id TEXT NOT NULL,
 sender_id TEXT NOT NULL,
 body TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','delivered','rejected','cancelled')),
 receipt_id TEXT,
 PRIMARY KEY(gateway_id,event_id)
);
CREATE TABLE IF NOT EXISTS projection_gateway_outbox (
 gateway_id TEXT NOT NULL REFERENCES projection_gateways(gateway_id),
 reply_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 conversation_id TEXT NOT NULL,
 sender_id TEXT NOT NULL,
 body TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('review','ready','sending','sent','uncertain','cancelled')),
 provider_receipt TEXT,
 PRIMARY KEY(gateway_id,reply_id)
);
`;
