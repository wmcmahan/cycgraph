/**
 * Database Connection Layer
 *
 * Provides a lazily-initialised PostgreSQL connection pool and Drizzle ORM
 * instance. No connections are opened at import time — call {@link getDb}
 * once during application startup to warm the pool.
 *
 * @module @cycgraph/orchestrator-postgres
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const TAG = '[mcai/orchestrator-postgres]';

let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _appPool: pg.Pool | null = null;
let _appDb: ReturnType<typeof drizzle> | null = null;
let _platformPool: pg.Pool | null = null;
let _platformDb: ReturnType<typeof drizzle> | null = null;

async function createPoolWithRetry(connectionString: string): Promise<pg.Pool> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });

    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

      pool.on('error', (err: Error) => {
        console.error(`${TAG} Idle pool connection error:`, err.message);
      });

      console.info(`${TAG} Connection established (pool max: ${pool.options.max})`);
      return pool;
    } catch (error) {
      await pool.end().catch(() => { });

      if (attempt === MAX_RETRIES) {
        console.error(`${TAG} Failed to connect after ${MAX_RETRIES} attempts`);
        throw error;
      }

      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(
        `${TAG} Connection attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms:`,
        error instanceof Error ? error.message : error,
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(`${TAG} Failed to create database pool`);
}

function requireDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      `${TAG} DATABASE_URL is not set. ` +
      `Set it to a valid PostgreSQL connection string before starting the application.`
    );
  }
  return connectionString;
}

export async function getPool(): Promise<pg.Pool> {
  if (!_pool) _pool = await createPoolWithRetry(requireDatabaseUrl());
  return _pool;
}

export async function getDb(): Promise<ReturnType<typeof drizzle>> {
  if (!_db) _db = drizzle(await getPool(), { schema });
  return _db;
}

/**
 * The tenant-plane ("app role") Drizzle instance — used by {@link withTenant}
 * so RLS-subject queries run as a non-owner role once RLS is enforced.
 *
 * Backed by `APP_DATABASE_URL` (point it at a non-owner login role that has
 * `cycgraph_app` membership). When `APP_DATABASE_URL` is unset it falls back to
 * the owner {@link getDb} instance — so dev / single-tenant / CI keep working
 * with one connection string (RLS, which the owner bypasses, simply doesn't
 * engage; the adapters' app-level `tenant_id` filters still isolate).
 */
export async function getAppDb(): Promise<ReturnType<typeof drizzle>> {
  const appUrl = process.env.APP_DATABASE_URL;
  if (!appUrl) return getDb();
  if (!_appDb) {
    _appPool = await createPoolWithRetry(appUrl);
    _appDb = drizzle(_appPool, { schema });
    console.info(`${TAG} App-role (RLS-subject) connection established`);
  }
  return _appDb;
}

/**
 * The platform-plane Drizzle instance — used by {@link withPlatform} for
 * cross-tenant work (queue dequeue/reclaim, retention GC) that must bypass RLS.
 *
 * Backed by `PLATFORM_DATABASE_URL` (point it at the `cycgraph_admin` BYPASSRLS
 * role from migration `0019`). When unset it falls back to the owner
 * {@link getDb} instance — correct for dev / single-tenant and for a superuser
 * owner (which bypasses RLS anyway). In production with `FORCE` RLS and a
 * non-superuser owner, this MUST be set or platform sweeps would be filtered.
 */
export async function getPlatformDb(): Promise<ReturnType<typeof drizzle>> {
  const platformUrl = process.env.PLATFORM_DATABASE_URL;
  if (!platformUrl) return getDb();
  if (!_platformDb) {
    _platformPool = await createPoolWithRetry(platformUrl);
    _platformDb = drizzle(_platformPool, { schema });
    console.info(`${TAG} Platform-role (BYPASSRLS) connection established`);
  }
  return _platformDb;
}

export async function closeDb(): Promise<void> {
  if (_platformPool) {
    await _platformPool.end();
    _platformPool = null;
    _platformDb = null;
  }
  if (_appPool) {
    await _appPool.end();
    _appPool = null;
    _appDb = null;
  }
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    console.info(`${TAG} Pool closed`);
  }
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop, receiver) {
    if (!_db) {
      throw new Error(
        `${TAG} 'db' accessed before initialisation. ` +
        `Call 'await getDb()' at application startup first.`
      );
    }
    return Reflect.get(_db, prop, receiver);
  },
});

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export function getPoolMetrics(): PoolMetrics {
  if (!_pool) {
    throw new Error(`${TAG} Pool not initialised. Call 'await getDb()' first.`);
  }
  return {
    totalCount: _pool.totalCount,
    idleCount: _pool.idleCount,
    waitingCount: _pool.waitingCount,
  };
}
