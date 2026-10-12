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

export const WHATSAPP_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_whatsapp_receipts (
 gateway_id TEXT NOT NULL REFERENCES projection_gateways(gateway_id),
 event_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('message','status')),
 sender_id TEXT NOT NULL,
 provider_timestamp INTEGER NOT NULL,
 event_json TEXT NOT NULL CHECK(json_valid(event_json)),
 PRIMARY KEY(gateway_id,event_id,kind)
);
`;

export const SLACK_INSTALLATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_slack_installations (
 team_id TEXT NOT NULL,
 bot_user_id TEXT NOT NULL,
 app_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 credential_handle TEXT NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 PRIMARY KEY(team_id,bot_user_id),
 UNIQUE(team_id,agent_id)
);
CREATE TABLE IF NOT EXISTS projection_slack_oauth_states (
 state_digest TEXT PRIMARY KEY,
 agent_id TEXT NOT NULL,
 app_id TEXT NOT NULL,
 redirect_url TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projection_slack_events (
 team_id TEXT NOT NULL,
 app_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 agent_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('received','review','rejected','cancelled')),
 event_json TEXT NOT NULL CHECK(json_valid(event_json)),
 PRIMARY KEY(team_id,app_id,event_id)
);
`;

export const PEER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_peer_contacts (
 contact_id TEXT PRIMARY KEY,
 transport_principal TEXT NOT NULL UNIQUE,
 human_handle TEXT NOT NULL,
 connected INTEGER NOT NULL CHECK(connected IN (0,1))
);
CREATE TABLE IF NOT EXISTS projection_peer_grants (
 grant_id TEXT PRIMARY KEY,
 contact_id TEXT NOT NULL REFERENCES projection_peer_contacts(contact_id),
 purpose TEXT NOT NULL,
 capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
 audiences_json TEXT NOT NULL CHECK(json_valid(audiences_json)),
 expires_at INTEGER NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS projection_peer_requests (
 request_id TEXT PRIMARY KEY,
 contact_id TEXT NOT NULL,
 transport_principal TEXT NOT NULL,
 context_id TEXT NOT NULL,
 principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
 envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
 text TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('message-taker','owner-review','consent-pending','accepted','declined','completed','cancelled','timed-out')),
 grant_id TEXT,
 deadline INTEGER
);
`;

export const PEER_KEYS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_peer_keys (
 fingerprint TEXT PRIMARY KEY,
 contact_id TEXT NOT NULL REFERENCES projection_peer_contacts(contact_id),
 public_key_pem TEXT NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
);
`;

export const PEER_EFFECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_peer_received (
 request_id TEXT PRIMARY KEY,
 received_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO projection_peer_received SELECT request_id,unixepoch()*1000 FROM projection_peer_requests;
CREATE TABLE IF NOT EXISTS projection_peer_replay_tombstones (
 request_id TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_peer_effects (
 request_id TEXT PRIMARY KEY REFERENCES projection_peer_requests(request_id),
 envelope_hash TEXT NOT NULL,
 capability TEXT NOT NULL,
 audiences_json TEXT NOT NULL CHECK(json_valid(audiences_json)),
 money_ceiling REAL CHECK(money_ceiling IS NULL OR money_ceiling >= 0),
 claim_token TEXT,
 state TEXT NOT NULL CHECK(state IN ('approved','executing','completed','uncertain','cancelled')),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);
CREATE TRIGGER IF NOT EXISTS peer_request_identity_immutable BEFORE UPDATE OF request_id,envelope_json,transport_principal,contact_id,text,context_id,deadline ON projection_peer_requests
BEGIN SELECT RAISE(ABORT,'Peer identity and envelope are immutable'); END;
CREATE TRIGGER IF NOT EXISTS peer_accepted_requires_grant BEFORE UPDATE OF state ON projection_peer_requests
WHEN NEW.state='accepted' AND NEW.grant_id IS NULL
BEGIN SELECT RAISE(ABORT,'Accepted peer request requires grant'); END;
CREATE TRIGGER IF NOT EXISTS peer_insert_requires_grant BEFORE INSERT ON projection_peer_requests
WHEN NEW.state='accepted' AND (NEW.grant_id IS NULL OR NOT EXISTS (SELECT 1 FROM projection_peer_grants WHERE grant_id=NEW.grant_id AND contact_id=NEW.contact_id))
BEGIN SELECT RAISE(ABORT,'Accepted peer request requires matching grant'); END;
CREATE TRIGGER IF NOT EXISTS peer_effect_intent_limit BEFORE INSERT ON projection_peer_effects
WHEN NOT EXISTS (SELECT 1 FROM projection_peer_requests WHERE request_id=NEW.request_id AND json_extract(envelope_json,'$.intent') IN ('request_freebusy','propose_times'))
BEGIN SELECT RAISE(ABORT,'Commit effects are unavailable'); END;
CREATE TRIGGER IF NOT EXISTS peer_grant_binding BEFORE UPDATE OF grant_id,state ON projection_peer_requests
WHEN NEW.state='accepted' AND NOT EXISTS (SELECT 1 FROM projection_peer_grants WHERE grant_id=NEW.grant_id AND contact_id=NEW.contact_id)
BEGIN SELECT RAISE(ABORT,'Grant does not match peer'); END;
CREATE TRIGGER IF NOT EXISTS peer_grant_immutable BEFORE UPDATE OF grant_id ON projection_peer_requests
WHEN OLD.grant_id IS NOT NULL AND NEW.grant_id IS NOT OLD.grant_id
BEGIN SELECT RAISE(ABORT,'Accepted grant is immutable'); END;


`;
