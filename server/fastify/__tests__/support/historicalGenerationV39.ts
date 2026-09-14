import type { DatabaseSync } from 'node:sqlite'

/**
 * Replace the generation tables with their checked-in v39 definitions.
 *
 * This is intentionally a fixed historical schema snapshot. Using the current
 * migration catalog to manufacture a "v39" database would execute today's
 * amended table creators and could not prove that v40 upgrades old tables.
 */
export function installHistoricalGenerationV39Schema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;

    DROP TABLE IF EXISTS generation_finalization_retries;
    DROP TABLE IF EXISTS generation_effects;
    DROP TABLE IF EXISTS generation_operation_attempts;
    DROP TABLE IF EXISTS generation_operations;
    DROP TABLE IF EXISTS generation_operation_projection_state;
    DROP TABLE IF EXISTS chat_occupancies;

    CREATE TABLE generation_operations (
      database_lineage TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      protocol_version INTEGER NOT NULL CHECK (protocol_version >= 0),
      request_origin TEXT NOT NULL
        CHECK (request_origin IN ('unbound', 'accepted_send', 'continue', 'regenerate', 'legacy')),
      creator_writer_session_id TEXT NOT NULL,
      creator_writer_epoch INTEGER NOT NULL CHECK (creator_writer_epoch >= 0),
      binding_server_instance_id TEXT,

      character_id TEXT,
      chat_id TEXT,
      mode TEXT CHECK (mode IS NULL OR mode IN ('send', 'continue', 'regenerate')),
      accepted_message_id TEXT,
      target_message_id TEXT,
      client_draft_generation_json TEXT
        CHECK (client_draft_generation_json IS NULL OR json_valid(client_draft_generation_json)),

      request_fingerprint TEXT,
      intent_json TEXT CHECK (intent_json IS NULL OR json_valid(intent_json)),
      accepted_revision INTEGER CHECK (accepted_revision IS NULL OR accepted_revision >= 0),

      state TEXT NOT NULL CHECK (state IN (
        'cancel_requested',
        'accepted',
        'launching',
        'owned_by_job',
        'stopping',
        'finalizing',
        'retryable',
        'abandoned',
        'completed',
        'cancelled',
        'terminal_failed',
        'invalidated'
      )),
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
      projection_epoch INTEGER NOT NULL CHECK (projection_epoch > 0),
      current_attempt_no INTEGER CHECK (current_attempt_no IS NULL OR current_attempt_no > 0),

      desired_terminal_outcome TEXT
        CHECK (desired_terminal_outcome IS NULL OR desired_terminal_outcome IN ('completed', 'cancelled')),
      result_message_id TEXT,
      failure_code TEXT,
      failure_phase TEXT,
      last_error TEXT,
      provider_may_have_run INTEGER NOT NULL DEFAULT 0 CHECK (provider_may_have_run IN (0, 1)),

      cancel_requested_at TEXT,
      runner_settled_at TEXT,
      terminal_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      PRIMARY KEY (database_lineage, operation_id),
      CHECK (
        (
          request_origin = 'unbound'
          AND state = 'cancel_requested'
          AND request_fingerprint IS NULL
          AND intent_json IS NULL
          AND binding_server_instance_id IS NULL
        )
        OR request_origin = 'legacy'
        OR (
          character_id IS NOT NULL
          AND chat_id IS NOT NULL
          AND mode IS NOT NULL
          AND request_fingerprint IS NOT NULL
          AND intent_json IS NOT NULL
          AND binding_server_instance_id IS NOT NULL
        )
      ),
      CHECK (
        request_origin IN ('unbound', 'legacy')
        OR mode IS NULL OR mode <> 'send'
        OR accepted_message_id IS NOT NULL
      ),
      CHECK (
        request_origin IN ('unbound', 'legacy')
        OR (request_origin = 'accepted_send' AND mode = 'send')
        OR request_origin = mode
      )
    );

    CREATE UNIQUE INDEX generation_operations_one_live_chat
      ON generation_operations (database_lineage, chat_id)
      WHERE state IN ('accepted', 'launching', 'owned_by_job', 'stopping');

    CREATE TABLE generation_operation_attempts (
      database_lineage TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      retry_request_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      server_instance_id TEXT NOT NULL,
      actor_writer_session_id TEXT NOT NULL,
      actor_writer_epoch INTEGER NOT NULL CHECK (actor_writer_epoch >= 0),
      status TEXT NOT NULL CHECK (status IN (
        'reserved', 'running', 'stopping', 'finalizing',
        'completed', 'cancelled', 'retryable_failed',
        'terminal_failed', 'abandoned'
      )),
      launch_revision INTEGER NOT NULL CHECK (launch_revision >= 0),
      provider_dispatch_started_at TEXT,
      provider_dispatch_finished_at TEXT,
      runner_settled_at TEXT,
      finalization_generation_id TEXT,
      failure_code TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (database_lineage, operation_id, attempt_no),
      UNIQUE (database_lineage, retry_request_id),
      UNIQUE (job_id),
      FOREIGN KEY (database_lineage, operation_id)
        REFERENCES generation_operations(database_lineage, operation_id)
    );

    CREATE TABLE generation_operation_projection_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL CHECK (epoch >= 0)
    );
    INSERT INTO generation_operation_projection_state (id, epoch) VALUES (1, 0);

    CREATE TABLE generation_finalization_retries (
      generation_id TEXT PRIMARY KEY,
      database_lineage TEXT,
      operation_id TEXT,
      operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0),
      actor_writer_session_id TEXT,
      actor_writer_epoch INTEGER CHECK (actor_writer_epoch IS NULL OR actor_writer_epoch >= 0),
      accepted_message_id TEXT,
      terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'cancelled')),
      chat_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('send', 'continue', 'regenerate')),
      target_message_id TEXT,
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      alternate_messages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternate_messages_json)),
      chat_var_mutations_json TEXT NOT NULL CHECK (json_valid(chat_var_mutations_json)),
      target_snapshot_json TEXT CHECK (target_snapshot_json IS NULL OR json_valid(target_snapshot_json)),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      last_error TEXT,
      terminal_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'terminal')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX idx_generation_finalization_retries_status
      ON generation_finalization_retries (status, updated_at);

    CREATE TABLE generation_effects (
      database_lineage TEXT NOT NULL,
      key_type TEXT NOT NULL CHECK (key_type IN ('operation', 'generation')),
      key_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'igp', 'plugin_output', 'generated_translation',
        'notification', 'tts', 'completion_sound', 'emotion_image_state'
      )),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('durable', 'ephemeral', 'recomputed')),
      operation_id TEXT,
      generation_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'skipped', 'failed')),
      claim_id TEXT,
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('server', 'live_terminal', 'late_recovery')),
      reason TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      settled_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (database_lineage, key_type, key_id, effect_kind),
      UNIQUE (database_lineage, generation_id, effect_kind),
      CHECK (
        (key_type = 'operation' AND operation_id = key_id)
        OR key_type = 'generation'
      ),
      CHECK (
        (status = 'pending' AND claim_id IS NULL AND delivery IS NULL AND claimed_at IS NULL)
        OR (status <> 'pending' AND claim_id IS NOT NULL AND delivery IS NOT NULL AND claimed_at IS NOT NULL)
      )
    );

    CREATE INDEX generation_effects_pending
      ON generation_effects (database_lineage, status, updated_at);
    CREATE INDEX generation_effects_recoverable_claims
      ON generation_effects (database_lineage, status, lease_expires_at, effect_kind);

    UPDATE schema_version SET version = 39 WHERE id = 1;
    PRAGMA foreign_keys = ON;
  `)
}
