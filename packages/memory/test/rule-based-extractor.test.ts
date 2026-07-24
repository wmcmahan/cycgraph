import { describe, it, expect } from 'vitest';
import { RuleBasedExtractor } from '../src/hierarchy/rule-based-extractor.js';
import type { Episode } from '../src/schemas/episode.js';

function makeEpisode(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Episode {
  const now = new Date('2024-01-01T10:00:00Z');
  return {
    id: crypto.randomUUID(),
    topic: 'test topic',
    messages: messages.map((m, i) => ({
      id: crypto.randomUUID(),
      role: m.role,
      content: m.content,
      timestamp: new Date(now.getTime() + i * 60_000),
      metadata: {},
    })),
    started_at: now,
    ended_at: new Date(now.getTime() + messages.length * 60_000),
    fact_ids: [],
    provenance: { source: 'system', created_at: now },
  };
}

describe('RuleBasedExtractor', () => {
  const extractor = new RuleBasedExtractor();

  it('extracts entities and facts from "Alice Smith works at Acme Corp"', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.facts[0].content).toContain('Alice Smith works at Acme Corp');
    expect(result.facts[0].source_episode_ids).toEqual([ep.id]);
    expect(result.facts[0].entity_ids.length).toBeGreaterThanOrEqual(2);
  });

  it('detects person and organization entity types', () => {
    const entities = extractor.extractEntities('Alice Smith works at Acme Corp');
    const names = entities.map((e) => e.name);
    expect(names).toContain('Alice Smith');
    expect(names).toContain('Acme Corp');

    const alice = entities.find((e) => e.name === 'Alice Smith');
    expect(alice?.type).toBe('person');
    const acme = entities.find((e) => e.name === 'Acme Corp');
    expect(acme?.type).toBe('organization');
  });

  it('extracts entities from "Bob manages the Widget Project"', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Bob manages the Widget Project.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.facts[0].content).toContain('Bob manages the Widget Project');
  });

  it('extracts depends_on relationship pattern', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'The API depends on Redis for caching data.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.facts[0].content).toContain('API depends on Redis');
  });

  it('extracts multiple facts from multiple sentences in one message', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'Alice Smith works at Acme Corp. Bob manages the Widget Project. The system uses Redis.',
    }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBe(3);
  });

  it('returns no facts for empty messages', async () => {
    const ep = makeEpisode([{ role: 'user', content: '' }]);
    const result = await extractor.extract(ep);
    expect(result.facts).toHaveLength(0);
  });

  it('skips very short sentences (< 20 chars by default)', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Hi. This is a much longer sentence that should be extracted as a fact.' }]);
    const result = await extractor.extract(ep);
    // "Hi." is 3 chars, should be skipped
    expect(result.facts.length).toBe(1);
    expect(result.facts[0].content).toContain('longer sentence');
  });

  it('respects custom minSentenceLength', async () => {
    const shortExtractor = new RuleBasedExtractor({ minSentenceLength: 5 });
    const ep = makeEpisode([{ role: 'user', content: 'Hello world. Yes, okay then.' }]);
    const result = await shortExtractor.extract(ep);
    expect(result.facts.length).toBe(2);
  });

  it('deduplicates identical sentences', async () => {
    const ep = makeEpisode([
      { role: 'user', content: 'Alice Smith works at Acme Corp.' },
      { role: 'assistant', content: 'Alice Smith works at Acme Corp.' },
    ]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBe(1);
  });

  it('deduplicates case-insensitively', async () => {
    const ep = makeEpisode([
      { role: 'user', content: 'Alice Smith works at Acme Corp.' },
      { role: 'assistant', content: 'alice smith works at acme corp.' },
    ]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBe(1);
  });

  it('extractEntities detects @handles', () => {
    const entities = extractor.extractEntities('Message from @alice to @bob about the project');
    const names = entities.map((e) => e.name);
    expect(names).toContain('@alice');
    expect(names).toContain('@bob');
    const handle = entities.find((e) => e.name === '@alice');
    expect(handle?.type).toBe('person');
  });

  it('extractEntities detects ACRONYMS', () => {
    const entities = extractor.extractEntities('The API uses REST and HTTP protocols');
    const names = entities.map((e) => e.name);
    expect(names).toContain('API');
    expect(names).toContain('REST');
    expect(names).toContain('HTTP');
  });

  it('extractEntities detects camelCase identifiers', () => {
    const entities = extractor.extractEntities('The getUserData function calls fetchApi');
    const names = entities.map((e) => e.name);
    expect(names).toContain('getUserData');
    expect(names).toContain('fetchApi');
  });

  it('extractEntities detects organization suffixes correctly', () => {
    const entities = extractor.extractEntities('Work done by Global Inc and Local Ltd');
    const inc = entities.find((e) => e.name === 'Global Inc');
    const ltd = entities.find((e) => e.name === 'Local Ltd');
    expect(inc?.type).toBe('organization');
    expect(ltd?.type).toBe('organization');
  });

  it('extractEntities detects quoted terms', () => {
    const entities = extractor.extractEntities('The "context engine" is a key component');
    const names = entities.map((e) => e.name);
    expect(names).toContain('context engine');
  });

  it('extracts entities from code-like identifiers', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'The getUserData function calls the fetchApi module for data retrieval.',
    }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    const allEntityIds = result.facts.flatMap((f) => f.entity_ids);
    expect(allEntityIds.length).toBeGreaterThanOrEqual(2);
  });

  it('sets provenance source to derived', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts[0].provenance.source).toBe('derived');
  });

  it('sets valid_from to episode started_at', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts[0].valid_from).toEqual(ep.started_at);
  });

  it('handles multiple messages in an episode producing combined facts', async () => {
    const ep = makeEpisode([
      { role: 'user', content: 'Alice Smith works at Acme Corp.' },
      { role: 'assistant', content: 'Bob manages the Widget Project at the company.' },
    ]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBe(2);
  });

  it('extracts facts from sentences with no relationship verbs (attribute patterns)', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'The system is highly scalable and well designed for production use.',
    }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves abbreviations like Dr. and Mr. during sentence splitting', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'Dr. Smith and Mr. Jones discussed the architecture of the project.',
    }]);
    const result = await extractor.extract(ep);
    // Should be one sentence, not split on "Dr." or "Mr."
    expect(result.facts.length).toBe(1);
    expect(result.facts[0].content).toContain('Dr.');
  });

  it('extractEntities works as a standalone public method', () => {
    const entities = extractor.extractEntities('Alice Smith at Acme Corp uses @slack');
    expect(entities.length).toBeGreaterThanOrEqual(3);
    const names = entities.map((e) => e.name);
    expect(names).toContain('Alice Smith');
    expect(names).toContain('Acme Corp');
    expect(names).toContain('@slack');
  });

  it('accepts additional entity patterns via options', async () => {
    const custom = new RuleBasedExtractor({
      entityPatterns: [/\bTICKET-\d+\b/g],
    });
    const entities = custom.extractEntities('Fix TICKET-123 before release');
    const names = entities.map((e) => e.name);
    expect(names).toContain('TICKET-123');
  });

  it('accepts additional relationship verbs via options', async () => {
    const custom = new RuleBasedExtractor({
      relationshipVerbs: ['sponsors'],
    });
    // The verb list is extended; no crash
    const ep = makeEpisode([{ role: 'user', content: 'Acme Corp sponsors the Open Source event.' }]);
    const result = await custom.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
  });

  it('handles LLC suffix as organization', () => {
    const entities = extractor.extractEntities('Funded by Tech LLC and Design Co');
    const llc = entities.find((e) => e.name === 'Tech LLC');
    const co = entities.find((e) => e.name === 'Design Co');
    expect(llc?.type).toBe('organization');
    expect(co?.type).toBe('organization');
  });

  // ─── Entity and Relationship Extraction ─────────────────────────

  it('returns Entity records with correct types', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);

    expect(result.entities.length).toBeGreaterThanOrEqual(2);
    const alice = result.entities.find((e) => e.name === 'Alice Smith');
    const acme = result.entities.find((e) => e.name === 'Acme Corp');
    expect(alice).toBeDefined();
    expect(alice!.entity_type).toBe('person');
    expect(acme).toBeDefined();
    expect(acme!.entity_type).toBe('organization');
  });

  it('entity IDs in facts match returned entities', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);

    const entityIds = new Set(result.entities.map((e) => e.id));
    for (const fact of result.facts) {
      for (const eid of fact.entity_ids) {
        expect(entityIds.has(eid)).toBe(true);
      }
    }
  });

  it('extracts work_at relationship from "Alice Smith works at Acme Corp"', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);

    expect(result.relationships.length).toBeGreaterThanOrEqual(1);
    const rel = result.relationships.find((r) => r.relation_type === 'work_at');
    expect(rel).toBeDefined();

    const alice = result.entities.find((e) => e.name === 'Alice Smith');
    const acme = result.entities.find((e) => e.name === 'Acme Corp');
    expect(rel!.source_id).toBe(alice!.id);
    expect(rel!.target_id).toBe(acme!.id);
  });

  it('extracts manage relationship between two detected entities', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith manages the Widget Project at the company.' }]);
    const result = await extractor.extract(ep);

    const rel = result.relationships.find((r) => r.relation_type === 'manage');
    expect(rel).toBeDefined();

    const alice = result.entities.find((e) => e.name === 'Alice Smith');
    const widget = result.entities.find((e) => e.name === 'Widget Project');
    expect(alice).toBeDefined();
    expect(widget).toBeDefined();
    expect(rel!.source_id).toBe(alice!.id);
    expect(rel!.target_id).toBe(widget!.id);
  });

  it('returns empty relationships for sentences with no matching verbs', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'The system is highly scalable and well designed for production use.',
    }]);
    const result = await extractor.extract(ep);
    expect(result.relationships).toHaveLength(0);
  });

  it('does not match verb forms embedded inside other words', async () => {
    // Each sentence contains a verb stem only as a substring of an unrelated
    // word; substring matching fabricated a relationship for every one.
    const embeddedStemSentences = [
      'Alice Smith stayed home because Acme Corp closed early.',        // "use" in "because"
      'Alice Smith was misleading everyone at Acme Corp about payments.', // "lead" in "misleading"
      'Alice Smith wrote it down before Acme Corp even noticed.',       // "own" in "down"
      'Alice Smith causes friction whenever Acme Corp changes policy.', // "use" in "causes"
    ];
    for (const content of embeddedStemSentences) {
      const result = await extractor.extract(makeEpisode([{ role: 'user', content }]));
      expect(result.relationships, content).toHaveLength(0);
    }
  });

  it('still matches multi-word verb forms at word boundaries', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith worked at Acme Corp last year.' }]);
    const result = await extractor.extract(ep);
    const rel = result.relationships.find((r) => r.relation_type === 'work_at');
    expect(rel).toBeDefined();
  });

  it('does not emit an affirmative edge from a negated sentence', async () => {
    const negatedSentences = [
      'Alice Smith never worked at Acme Corp.',
      'Alice Smith does not manage the Acme Corp platform team.',
      "Alice Smith doesn't use the Acme Corp deployment system.",
      'Alice Smith no longer works at Acme Corp.',
    ];
    for (const content of negatedSentences) {
      const result = await extractor.extract(makeEpisode([{ role: 'user', content }]));
      expect(result.relationships, content).toHaveLength(0);
      // The fact itself still records the (negative) knowledge.
      expect(result.facts.length, content).toBeGreaterThanOrEqual(1);
    }
  });

  it('word-level coverage check does not suppress entities sharing a prefix', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'The Annual Report praised Ann for outstanding work this quarter.',
    }]);
    const result = await extractor.extract(ep);
    const names = result.entities.map((e) => e.name);
    // (The multi-word pattern absorbs the leading article — 'The Annual
    // Report' — a separate, pre-existing quirk. The point here is that the
    // person 'Ann' is no longer suppressed by substring containment.)
    expect(names.some((n) => n.includes('Annual Report'))).toBe(true);
    expect(names).toContain('Ann');
  });

  it('types natural org names via expanded cue words', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'Researchers at Copperfield University met staff from Halcyon FC and the Northern Grid Consortium.',
    }]);
    const result = await extractor.extract(ep);
    const typeOf = (name: string) => result.entities.find((e) => e.name === name)?.entity_type;
    expect(typeOf('Copperfield University')).toBe('organization');
    expect(typeOf('Halcyon FC')).toBe('organization');
    expect(typeOf('Northern Grid Consortium')).toBe('organization');
  });

  it('does not detect days or months as entities', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'The board met on Tuesday and again in March to discuss the Acme Corp budget.',
    }]);
    const result = await extractor.extract(ep);
    const names = result.entities.map((e) => e.name);
    expect(names).not.toContain('Tuesday');
    expect(names).not.toContain('March');
    expect(names).toContain('Acme Corp');
  });

  it('extracts natural news verbs without temporal entities stealing attribution', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'Meridian Software said on Tuesday that it has acquired Bluefin Analytics for an undisclosed sum.',
    }]);
    const result = await extractor.extract(ep);
    const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
    const rel = result.relationships.find((r) => r.relation_type === 'acquire');
    expect(rel).toBeDefined();
    expect(nameById.get(rel!.source_id)).toBe('Meridian Software');
    expect(nameById.get(rel!.target_id)).toBe('Bluefin Analytics');
  });

  it('does not detect bare honorifics as entities; titled appointments pair correctly', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: 'Riverside General has appointed Dr. Marcus Webb as chief of cardiology this year.',
    }]);
    const result = await extractor.extract(ep);
    expect(result.entities.map((e) => e.name)).not.toContain('Dr');
    const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
    const rel = result.relationships.find((r) => r.relation_type === 'appoint');
    expect(rel).toBeDefined();
    expect(nameById.get(rel!.target_id)).toBe('Marcus Webb');
  });

  it('possessive apostrophes do not create phantom quoted-term entities', async () => {
    const ep = makeEpisode([{
      role: 'user',
      content: "Bluefin's forty employees will join Meridian's data division next quarter.",
    }]);
    const result = await extractor.extract(ep);
    const names = result.entities.map((e) => e.name);
    expect(names.some((n) => n.includes('employees'))).toBe(false); // no phantom span
    // Possessive stripped cleanly ("Meridian's" → Meridian, not "Meridians").
    // ("Bluefin's" opens the sentence — sentence-start suppression applies.)
    expect(names).toContain('Meridian');
    expect(names).not.toContain('Meridians');
  });

  it('sets the episode fact_ids back-link to the extracted facts', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(ep.fact_ids).toEqual(result.facts.map((f) => f.id));
  });

  it('returns empty entities and relationships for empty messages', async () => {
    const ep = makeEpisode([{ role: 'user', content: '' }]);
    const result = await extractor.extract(ep);
    expect(result.entities).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });

  it('relationship valid_from matches episode started_at', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    for (const rel of result.relationships) {
      expect(rel.valid_from).toEqual(ep.started_at);
    }
  });

  it('entity provenance source is derived', async () => {
    const ep = makeEpisode([{ role: 'user', content: 'Alice Smith works at Acme Corp.' }]);
    const result = await extractor.extract(ep);
    for (const entity of result.entities) {
      expect(entity.provenance.source).toBe('derived');
    }
  });
});
