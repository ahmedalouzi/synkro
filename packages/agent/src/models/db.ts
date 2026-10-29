import { Pool } from 'pg';

let poolInstance: Pool | null = null;

function getPool(): Pool {
  if ((globalThis as any).__PEEP_DB_POOL__) return (globalThis as any).__PEEP_DB_POOL__;
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/peep_test'
    });
  }
  return poolInstance;
}

export function setDbPool(pool: Pool | null) {
  (globalThis as any).__PEEP_DB_POOL__ = pool;
  poolInstance = pool;
}

export const db = new Proxy({} as Pool, {
  get(_target, prop, _receiver) {
    const pool = getPool();
    const value = Reflect.get(pool, prop);
    if (typeof value === 'function') {
      return value.bind(pool);
    }
    return value;
  }
});

export async function initDbSchema() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    // Auth tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        plan VARCHAR(50) DEFAULT 'free'
      );
    `);
    
    // Migration for existing tables
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'free';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_customer_id VARCHAR(255);`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_subscription_id VARCHAR(255);`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_status VARCHAR(50) DEFAULT 'inactive';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_updated_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE TABLE IF NOT EXISTS billing_webhook_events (event_id VARCHAR(255) PRIMARY KEY, provider VARCHAR(50) NOT NULL, event_type VARCHAR(100) NOT NULL, user_id UUID REFERENCES users(id) ON DELETE SET NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_token VARCHAR(255) PRIMARY KEY,
        refresh_token VARCHAR(255) UNIQUE NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS rotated_refresh_tokens (
        refresh_token VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_rotated_refresh_user ON rotated_refresh_tokens(user_id);
    `);
    
    // Rate limits (Authentication brute force protection)
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        ip_or_email VARCHAR(255) PRIMARY KEY,
        attempts INT NOT NULL,
        window_start TIMESTAMP NOT NULL
      );
    `);
    
    // Usage accounting
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        request_id VARCHAR(255) NOT NULL,
        model_tier VARCHAR(50) NOT NULL,
        resolved_model VARCHAR(255) NOT NULL,
        input_tokens INT NOT NULL,
        output_tokens INT NOT NULL,
        total_tokens INT NOT NULL,
        estimated_cost NUMERIC(10, 5) NOT NULL,
        status VARCHAR(50) NOT NULL,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user_timestamp ON usage_records(user_id, timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_request_id ON usage_records(request_id);
    `);
    // Tab completions are metered separately from chat/agent usage.
    await client.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'chat';`);
    // Cheap-model requests cost fractions of a cent; 5 decimal places rounded many of them to zero.
    await client.query(`ALTER TABLE usage_records ALTER COLUMN estimated_cost TYPE NUMERIC(12, 8);`);

    // Global config (e.g., kill switch)
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    
    // Insert default kill switch if not exists
    await client.query(`
      INSERT INTO system_config (key, value)
      VALUES ('global_kill_switch', '{"is_active": false}')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Insert mock user for dev bypass
    if (process.env.SYNKRO_SEED_DEV_USER === 'true') {
      await client.query(`
        INSERT INTO users (id, email, password_hash, plan)
        VALUES ('00000000-0000-0000-0000-000000000000', 'dev@synkro.com', 'mock_hash', 'pro')
        ON CONFLICT (id) DO NOTHING;
      `);
    }

    // Chat Threads
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id);
    `);

    // Chat Messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY,
        thread_id UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        tool_calls JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
    `);

    // Chat Runs
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_runs (
        run_id VARCHAR(255) PRIMARY KEY,
        thread_id UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        status VARCHAR(50) NOT NULL,
        timeline_activities JSONB DEFAULT '[]'::jsonb,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_runs_thread ON chat_runs(thread_id);
    `);

    // Cloud Build Jobs
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE build_framework AS ENUM ('flutter', 'react-native');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
      
      DO $$ BEGIN
        CREATE TYPE build_status AS ENUM ('queued', 'running', 'success', 'failed', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS build_jobs (
        id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             UUID        NOT NULL,
        project_id          TEXT        NOT NULL,
        framework           build_framework NOT NULL DEFAULT 'flutter',
        target              TEXT        NOT NULL DEFAULT 'apk',
        status              build_status NOT NULL DEFAULT 'queued',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        build_duration_ms   INTEGER,
        source_path         TEXT,
        artifact_url        TEXT,
        artifact_size_bytes BIGINT,
        error_log           TEXT,
        worker_id           TEXT,
        container_id        TEXT,
        version_name        TEXT        NOT NULL DEFAULT '1.0.0',
        version_code        INTEGER     NOT NULL DEFAULT 1,
        keystore_secret_id  TEXT
      );
    `);

    await client.query(`
      ALTER TABLE build_jobs 
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS build_duration_ms INTEGER,
      ADD COLUMN IF NOT EXISTS source_path TEXT,
      ADD COLUMN IF NOT EXISTS artifact_url TEXT,
      ADD COLUMN IF NOT EXISTS artifact_size_bytes BIGINT,
      ADD COLUMN IF NOT EXISTS error_log TEXT,
      ADD COLUMN IF NOT EXISTS worker_id TEXT,
      ADD COLUMN IF NOT EXISTS container_id TEXT,
      ADD COLUMN IF NOT EXISTS version_name TEXT DEFAULT '1.0.0',
      ADD COLUMN IF NOT EXISTS version_code INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS keystore_secret_id TEXT,
      ADD COLUMN IF NOT EXISTS framework build_framework DEFAULT 'flutter',
      ADD COLUMN IF NOT EXISTS target TEXT DEFAULT 'apk',
      ADD COLUMN IF NOT EXISTS status build_status DEFAULT 'queued',
      ADD COLUMN IF NOT EXISTS signing_cert_sha256 TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_build_jobs_user_id    ON build_jobs(user_id);
      CREATE INDEX IF NOT EXISTS idx_build_jobs_status     ON build_jobs(status) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS idx_build_jobs_created_at ON build_jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_build_jobs_stuck      ON build_jobs(started_at) WHERE status = 'running';
    `);

    // Release signing keys (signing-keys.ts): one per (user, project), every secret column encrypted
    // with AES-256-GCM under SYNKRO_SIGNING_ENC_KEY.
    await client.query(`
      CREATE TABLE IF NOT EXISTS signing_keys (
        id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             UUID        NOT NULL,
        project_id          TEXT        NOT NULL,
        package_name        TEXT,
        alias               TEXT        NOT NULL,
        keystore_enc        BYTEA       NOT NULL,
        store_password_enc  BYTEA       NOT NULL,
        key_password_enc    BYTEA       NOT NULL,
        cert_sha256         TEXT        NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, project_id)
      );
    `);

    // Enable Row-Level Security
    await client.query(`
      ALTER TABLE signing_keys ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN
        CREATE POLICY signing_keys_user_isolation ON signing_keys
          USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID);
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      ALTER TABLE build_jobs ENABLE ROW LEVEL SECURITY;
      
      DO $$ BEGIN
        CREATE POLICY build_jobs_user_isolation ON build_jobs
          USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID);
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
      
      DO $$ BEGIN
        CREATE POLICY chat_threads_user_isolation ON chat_threads
          USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID);
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
      
      DO $$ BEGIN
        CREATE POLICY chat_messages_user_isolation ON chat_messages
          USING (EXISTS (
            SELECT 1 FROM chat_threads 
            WHERE id = chat_messages.thread_id 
            AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
          ));
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      ALTER TABLE chat_runs ENABLE ROW LEVEL SECURITY;
      
      DO $$ BEGIN
        CREATE POLICY chat_runs_user_isolation ON chat_runs
          USING (EXISTS (
            SELECT 1 FROM chat_threads 
            WHERE id = chat_runs.thread_id 
            AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
          ));
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create Roles and Grants
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE api_user NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN null; END $$;
      
      GRANT SELECT, INSERT ON build_jobs TO api_user;
      GRANT UPDATE (status) ON build_jobs TO api_user;
      -- Owners can only read their keys (keystore download); keys are created by the worker.
      GRANT SELECT ON signing_keys TO api_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON chat_threads, chat_messages, chat_runs TO api_user;

      DO $$ BEGIN
        CREATE ROLE worker_user BYPASSRLS NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN null; END $$;

      GRANT SELECT, UPDATE ON build_jobs TO worker_user;
      GRANT SELECT, INSERT ON signing_keys TO worker_user;
      GRANT UPDATE (package_name) ON signing_keys TO worker_user;
      GRANT SELECT ON users TO worker_user;

      -- Allow the session login role to switch into api_user / worker_user.
      -- SESSION_USER is the actual login credential (e.g. 'testuser' in test,
      -- 'postgres' in prod). Without this GRANT, SET LOCAL ROLE fails with
      -- "permission denied to set role".
      GRANT api_user TO SESSION_USER;
      GRANT worker_user TO SESSION_USER;
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
