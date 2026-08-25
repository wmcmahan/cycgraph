/**
 * Dashboard server
 *
 * Binds loopback only. The playground has no authentication and runs whatever
 * a request names, which is fine for a local tool and would not be anywhere
 * else — so it does not listen on an address anywhere else can reach.
 *
 * @module server/index
 */

import { createServer, type Server } from 'node:http';
import { handle } from './api.js';
import { createWatcher, type Watcher, type WatcherOptions } from './watcher.js';
import { createBus, type Bus } from './bus.js';
import { createLoopController, type LoopController } from './loop.js';
import { resolveStack, type Stack, type StackConfig } from '../stack/index.js';
import { catalogOf, type Catalog } from '../scenarios/catalog.js';

/**
 * Build the server around a stack it does not own.
 *
 * Caller listens and caller closes the stack, so tests can pick their own port
 * and their own resources.
 */
export function createDashboard(
  config: StackConfig,
  stack: Stack,
  watcher?: Watcher,
  bus?: Bus,
  catalog: Catalog = catalogOf([]),
  loop?: LoopController,
): Server {
  return createServer((req, res) => {
    handle(req, res, config, stack, watcher, bus, catalog, loop)
      .then((served) => {
        if (served) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      });
  });
}

/** A listening dashboard and the teardown for everything it holds open. */
export interface Dashboard {
  server: Server;
  stack: Stack;
  watcher: Watcher;
  /** Stop listening, then release the stack. Flushes pending spans. */
  close(): Promise<void>;
}

/**
 * Resolve one stack, then start on `port`.
 *
 * The stack lasts as long as the server. It holds the database pool and the
 * tracer provider, which are process-global and cannot be rebuilt once torn
 * down, so a per-request lifetime would leave later runs untraced and could
 * close the pool underneath a concurrent run.
 */
export async function startDashboard(
  config: StackConfig,
  port: number,
  watch: Partial<WatcherOptions> = {},
  catalog: Catalog = catalogOf([]),
): Promise<Dashboard> {
  const stack = await resolveStack(config);
  const bus = createBus();
  const watcher = createWatcher(stack, {
    auto: false,
    catalog,
    ...watch,
    onLine: (message) => {
      watch.onLine?.(message);
      bus.publish({ kind: 'watch', data: { message } });
    },
  });
  const loop = createLoopController(stack, (event) => {
    bus.publish({ kind: 'loop', data: { ...event } });
  });
  const server = createDashboard(config, stack, watcher, bus, catalog, loop);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    await stack.close();
    throw err;
  }

  return {
    server,
    stack,
    watcher,
    close: async () => {
      watcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stack.close();
    },
  };
}
