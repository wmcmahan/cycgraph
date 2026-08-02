import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';
import {
  registerDefaultMCPServers,
  DEFAULT_MCP_SERVERS,
  WEB_SEARCH_SERVER,
  FETCH_SERVER,
} from '../src/mcp/default-servers.js';

describe('Default MCP Servers', () => {
  let registry: InMemoryMCPServerRegistry;

  beforeEach(() => {
    registry = new InMemoryMCPServerRegistry();
  });

  it('DEFAULT_MCP_SERVERS contains web-search and fetch', () => {
    expect(DEFAULT_MCP_SERVERS).toHaveLength(2);
    expect(DEFAULT_MCP_SERVERS.map(s => s.id)).toEqual(['web-search', 'fetch']);
  });

  it('WEB_SEARCH_SERVER has correct structure', () => {
    expect(WEB_SEARCH_SERVER.id).toBe('web-search');
    expect(WEB_SEARCH_SERVER.transport.type).toBe('stdio');
    if (WEB_SEARCH_SERVER.transport.type === 'stdio') {
      expect(WEB_SEARCH_SERVER.transport.command).toBe('npx');
      expect(WEB_SEARCH_SERVER.transport.args).toContain('@modelcontextprotocol/server-brave-search');
      expect(WEB_SEARCH_SERVER.transport.args).toContain('--silent');
    }
  });

  it('FETCH_SERVER has correct structure', () => {
    expect(FETCH_SERVER.id).toBe('fetch');
    expect(FETCH_SERVER.transport.type).toBe('stdio');
    if (FETCH_SERVER.transport.type === 'stdio') {
      expect(FETCH_SERVER.transport.command).toBe('uvx');
      expect(FETCH_SERVER.transport.args).toContain('mcp-server-fetch');
    }
  });

  describe('registerDefaultMCPServers', () => {
    it('registers all defaults when no options provided', async () => {
      const registered = await registerDefaultMCPServers(registry);

      expect(registered).toEqual(['web-search', 'fetch']);
      expect(await registry.loadServer('web-search')).not.toBeNull();
      expect(await registry.loadServer('fetch')).not.toBeNull();
    });

    it('respects "only" filter', async () => {
      const registered = await registerDefaultMCPServers(registry, {
        only: ['fetch'],
      });

      expect(registered).toEqual(['fetch']);
      expect(await registry.loadServer('web-search')).toBeNull();
      expect(await registry.loadServer('fetch')).not.toBeNull();
    });

    it('respects "exclude" filter', async () => {
      const registered = await registerDefaultMCPServers(registry, {
        exclude: ['web-search'],
      });

      expect(registered).toEqual(['fetch']);
      expect(await registry.loadServer('web-search')).toBeNull();
      expect(await registry.loadServer('fetch')).not.toBeNull();
    });

    it('applies allowed_agents override', async () => {
      await registerDefaultMCPServers(registry, {
        allowedAgents: ['agent-1', 'agent-2'],
      });

      const webSearch = await registry.loadServer('web-search');
      const fetch = await registry.loadServer('fetch');

      expect(webSearch?.allowed_agents).toEqual(['agent-1', 'agent-2']);
      expect(fetch?.allowed_agents).toEqual(['agent-1', 'agent-2']);
    });

    it('applies brave_api_key override to web-search', async () => {
      await registerDefaultMCPServers(registry, {
        braveApiKey: 'BSA-test-key-123',
      });

      const webSearch = await registry.loadServer('web-search');
      expect(webSearch).not.toBeNull();
      if (webSearch?.transport.type === 'stdio') {
        expect(webSearch.transport.env?.BRAVE_API_KEY).toBe('BSA-test-key-123');
      }
    });

    it('does not mutate original server entries', async () => {
      await registerDefaultMCPServers(registry, {
        braveApiKey: 'BSA-override',
        allowedAgents: ['agent-x'],
      });
      expect(WEB_SEARCH_SERVER.allowed_agents).toBeUndefined();
      if (WEB_SEARCH_SERVER.transport.type === 'stdio') {
        expect(WEB_SEARCH_SERVER.transport.env).toBeUndefined();
      }
    });

    it('only + exclude combined — exclude takes precedence', async () => {
      const registered = await registerDefaultMCPServers(registry, {
        only: ['web-search', 'fetch'],
        exclude: ['web-search'],
      });

      expect(registered).toEqual(['fetch']);
    });

    it('returns empty array when all servers are excluded', async () => {
      const registered = await registerDefaultMCPServers(registry, {
        exclude: ['web-search', 'fetch'],
      });

      expect(registered).toEqual([]);
      expect(await registry.listServers()).toHaveLength(0);
    });

    it('is idempotent — re-registering overwrites cleanly', async () => {
      await registerDefaultMCPServers(registry);
      await registerDefaultMCPServers(registry);

      const servers = await registry.listServers();
      expect(servers).toHaveLength(2);
    });
  });
});
