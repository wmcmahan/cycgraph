/**
 * Tests for hierarchy/rule-based-extractor: sentence-level extraction of
 * atomic facts, entities (with typing), and relationships (verb-inflected,
 * negation- and boundary-aware) from episodes.
 */

import { describe, it, expect } from 'vitest';
import { RuleBasedExtractor } from '../src/hierarchy/rule-based-extractor.js';
import { makeEpisode, makeMessage } from './helpers.js';
import type { Episode } from '../src/schemas/episode.js';

const ALICE_ACME = 'Alice Smith works at Acme Corp.';

function episode(...contents: Array<{ role: 'user' | 'assistant'; content: string }>): Episode {
  return makeEpisode({ messages: contents.map((m) => makeMessage({ role: m.role, content: m.content })) });
}

function userSays(content: string): Episode {
  return episode({ role: 'user', content });
}

describe('RuleBasedExtractor', () => {
  const extractor = new RuleBasedExtractor();

  describe('fact extraction', () => {
    it('extracts a fact spanning the whole sentence with its entity ids', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      expect(result.facts[0].content).toContain('Alice Smith works at Acme Corp');
      expect(result.facts[0].source_episode_ids).toEqual([ep.id]);
      expect(result.facts[0].entity_ids.length).toBeGreaterThanOrEqual(2);
    });

    it('extracts one fact per sentence in a message', async () => {
      const ep = userSays(
        'Alice Smith works at Acme Corp. Bob manages the Widget Project. The system uses Redis.',
      );

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(3);
    });

    it('reuses one entity id when the same entity spans multiple sentences', async () => {
      const ep = userSays('Alice Smith works at Acme Corp. Alice Smith also leads the Redis Team.');

      const result = await extractor.extract(ep);

      expect(result.entities.filter((e) => e.name === 'Alice Smith')).toHaveLength(1);
    });

    it('combines facts across multiple messages', async () => {
      const ep = episode(
        { role: 'user', content: ALICE_ACME },
        { role: 'assistant', content: 'Bob manages the Widget Project at the company.' },
      );

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(2);
    });

    it('extracts facts from sentences with no relationship verbs', async () => {
      const ep = userSays('The system is highly scalable and well designed for production use.');

      const result = await extractor.extract(ep);

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
    });

    it('returns no facts for an empty message', async () => {
      const result = await extractor.extract(userSays(''));

      expect(result.facts).toHaveLength(0);
    });
  });

  describe('sentence handling', () => {
    it('skips sentences shorter than the default minimum length', async () => {
      const ep = userSays('Hi. This is a much longer sentence that should be extracted as a fact.');

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toContain('longer sentence');
    });

    it('deduplicates identical sentences', async () => {
      const ep = episode(
        { role: 'user', content: ALICE_ACME },
        { role: 'assistant', content: ALICE_ACME },
      );

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(1);
    });

    it('deduplicates sentences case-insensitively', async () => {
      const ep = episode(
        { role: 'user', content: ALICE_ACME },
        { role: 'assistant', content: 'alice smith works at acme corp.' },
      );

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(1);
    });

    it('preserves abbreviations like Dr. and Mr. instead of splitting on them', async () => {
      const ep = userSays('Dr. Smith and Mr. Jones discussed the architecture of the project.');

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toContain('Dr.');
    });
  });

  describe('extractEntities', () => {
    it('types multi-word capitalized names as person and organization', () => {
      const entities = extractor.extractEntities('Alice Smith works at Acme Corp');

      expect(entities.find((e) => e.name === 'Alice Smith')?.type).toBe('person');
      expect(entities.find((e) => e.name === 'Acme Corp')?.type).toBe('organization');
    });

    it('types LLC and Co suffixes as organizations', () => {
      const entities = extractor.extractEntities('Funded by Tech LLC and Design Co');

      expect(entities.find((e) => e.name === 'Tech LLC')?.type).toBe('organization');
      expect(entities.find((e) => e.name === 'Design Co')?.type).toBe('organization');
    });

    it('detects @handles as person entities', () => {
      const entities = extractor.extractEntities('Message from @alice to @bob about the project');

      const names = entities.map((e) => e.name);
      expect(names).toContain('@alice');
      expect(names).toContain('@bob');
      expect(entities.find((e) => e.name === '@alice')?.type).toBe('person');
    });

    it('detects acronyms', () => {
      const entities = extractor.extractEntities('The API uses REST and HTTP protocols');

      const names = entities.map((e) => e.name);
      expect(names).toContain('API');
      expect(names).toContain('REST');
      expect(names).toContain('HTTP');
    });

    it('detects camelCase identifiers', () => {
      const entities = extractor.extractEntities('The getUserData function calls fetchApi');

      const names = entities.map((e) => e.name);
      expect(names).toContain('getUserData');
      expect(names).toContain('fetchApi');
    });

    it('detects double-quoted terms', () => {
      const entities = extractor.extractEntities('The "context engine" is a key component');

      expect(entities.map((e) => e.name)).toContain('context engine');
    });

    it('detects single-quoted terms', () => {
      const entities = extractor.extractEntities("The 'context engine' powers retrieval here");

      expect(entities.map((e) => e.name)).toContain('context engine');
    });

    it('extracts a mix of entity kinds in one pass', () => {
      const entities = extractor.extractEntities('Alice Smith at Acme Corp uses @slack');

      const names = entities.map((e) => e.name);
      expect(names).toContain('Alice Smith');
      expect(names).toContain('Acme Corp');
      expect(names).toContain('@slack');
    });
  });

  describe('entity typing edge cases', () => {
    it('types natural organization names via expanded cue words', async () => {
      const ep = userSays(
        'Researchers at Copperfield University met staff from Halcyon FC and the Northern Grid Consortium.',
      );

      const result = await extractor.extract(ep);

      const typeOf = (name: string) => result.entities.find((e) => e.name === name)?.entity_type;
      expect(typeOf('Copperfield University')).toBe('organization');
      expect(typeOf('Halcyon FC')).toBe('organization');
      expect(typeOf('Northern Grid Consortium')).toBe('organization');
    });

    it('excludes days and months from entities', async () => {
      const ep = userSays('The board met on Tuesday and again in March to discuss the Acme Corp budget.');

      const result = await extractor.extract(ep);

      const names = result.entities.map((e) => e.name);
      expect(names).not.toContain('Tuesday');
      expect(names).not.toContain('March');
      expect(names).toContain('Acme Corp');
    });

    it('excludes bare honorifics from entities', async () => {
      const ep = userSays('Riverside General has appointed Dr. Marcus Webb as chief of cardiology this year.');

      const result = await extractor.extract(ep);

      expect(result.entities.map((e) => e.name)).not.toContain('Dr');
    });

    it('keeps a person whose name is a prefix of a multi-word entity', async () => {
      const ep = userSays('The Annual Report praised Ann for outstanding work this quarter.');

      const result = await extractor.extract(ep);

      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.includes('Annual Report'))).toBe(true);
      expect(names).toContain('Ann');
    });

    it('strips possessives without creating phantom quoted-term entities', async () => {
      const ep = userSays("Bluefin's forty employees will join Meridian's data division next quarter.");

      const result = await extractor.extract(ep);

      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.includes('employees'))).toBe(false);
      expect(names).toContain('Meridian');
      expect(names).not.toContain('Meridians');
    });
  });

  describe('relationship extraction', () => {
    it('extracts a work_at relationship between the two detected entities', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      const rel = result.relationships.find((r) => r.relation_type === 'work_at');
      const alice = result.entities.find((e) => e.name === 'Alice Smith');
      const acme = result.entities.find((e) => e.name === 'Acme Corp');
      expect(rel!.source_id).toBe(alice!.id);
      expect(rel!.target_id).toBe(acme!.id);
    });

    it('extracts a manage relationship between the two detected entities', async () => {
      const ep = userSays('Alice Smith manages the Widget Project at the company.');

      const result = await extractor.extract(ep);

      const rel = result.relationships.find((r) => r.relation_type === 'manage');
      const alice = result.entities.find((e) => e.name === 'Alice Smith');
      const widget = result.entities.find((e) => e.name === 'Widget Project');
      expect(rel!.source_id).toBe(alice!.id);
      expect(rel!.target_id).toBe(widget!.id);
    });

    it('matches an inflected verb form at word boundaries', async () => {
      const ep = userSays('Alice Smith worked at Acme Corp last year.');

      const result = await extractor.extract(ep);

      expect(result.relationships.find((r) => r.relation_type === 'work_at')).toBeDefined();
    });

    it('does not match verb stems embedded inside unrelated words', async () => {
      const embeddedStemSentences = [
        'Alice Smith stayed home because Acme Corp closed early.',
        'Alice Smith was misleading everyone at Acme Corp about payments.',
        'Alice Smith wrote it down before Acme Corp even noticed.',
        'Alice Smith causes friction whenever Acme Corp changes policy.',
      ];

      for (const content of embeddedStemSentences) {
        const result = await extractor.extract(userSays(content));
        expect(result.relationships, content).toHaveLength(0);
      }
    });

    it('does not emit an affirmative edge from a negated sentence but keeps the fact', async () => {
      const negatedSentences = [
        'Alice Smith never worked at Acme Corp.',
        'Alice Smith does not manage the Acme Corp platform team.',
        "Alice Smith doesn't use the Acme Corp deployment system.",
        'Alice Smith no longer works at Acme Corp.',
      ];

      for (const content of negatedSentences) {
        const result = await extractor.extract(userSays(content));
        expect(result.relationships, content).toHaveLength(0);
        expect(result.facts.length, content).toBeGreaterThanOrEqual(1);
      }
    });

    it('attributes a news verb to the real endpoints past a temporal word', async () => {
      const ep = userSays(
        'Meridian Software said on Tuesday that it has acquired Bluefin Analytics for an undisclosed sum.',
      );

      const result = await extractor.extract(ep);

      const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
      const rel = result.relationships.find((r) => r.relation_type === 'acquire');
      expect(nameById.get(rel!.source_id)).toBe('Meridian Software');
      expect(nameById.get(rel!.target_id)).toBe('Bluefin Analytics');
    });

    it('pairs a titled appointment with the named person, not the honorific', async () => {
      const ep = userSays('Riverside General has appointed Dr. Marcus Webb as chief of cardiology this year.');

      const result = await extractor.extract(ep);

      const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
      const rel = result.relationships.find((r) => r.relation_type === 'appoint');
      expect(nameById.get(rel!.target_id)).toBe('Marcus Webb');
    });

    it('ignores a custom-pattern entity that has no word-boundary position in the sentence', async () => {
      const custom = new RuleBasedExtractor({ entityPatterns: [/z(bar)z/g] });
      const ep = userSays('Alice Smith works at Acme Corp near zbarz today.');

      const result = await custom.extract(ep);

      expect(result.entities.map((e) => e.name)).toContain('bar');
      expect(result.relationships.find((r) => r.relation_type === 'work_at')).toBeDefined();
    });

    it('returns no relationships for a sentence with no matching verbs', async () => {
      const ep = userSays('The system is highly scalable and well designed for production use.');

      const result = await extractor.extract(ep);

      expect(result.relationships).toHaveLength(0);
    });
  });

  describe('options', () => {
    it('respects a custom minSentenceLength', async () => {
      const shortExtractor = new RuleBasedExtractor({ minSentenceLength: 5 });
      const ep = userSays('Hello world. Yes, okay then.');

      const result = await shortExtractor.extract(ep);

      expect(result.facts).toHaveLength(2);
    });

    it('detects entities matched by an additional entity pattern', () => {
      const custom = new RuleBasedExtractor({ entityPatterns: [/\bTICKET-\d+\b/g] });

      const entities = custom.extractEntities('Fix TICKET-123 before release');

      expect(entities.map((e) => e.name)).toContain('TICKET-123');
    });

    it('applies a global flag to a non-global additional entity pattern', () => {
      const custom = new RuleBasedExtractor({ entityPatterns: [/NOTE-\d+/] });

      const entities = custom.extractEntities('See NOTE-7 and NOTE-8 in the log');

      const names = entities.map((e) => e.name);
      expect(names).toContain('NOTE-7');
      expect(names).toContain('NOTE-8');
    });

    it('extracts a relationship for an additional relationship verb', async () => {
      const custom = new RuleBasedExtractor({ relationshipVerbs: ['sponsor'] });
      const ep = userSays('Acme Corp sponsors the Open Source event every year.');

      const result = await custom.extract(ep);

      expect(result.relationships.find((r) => r.relation_type === 'sponsor')).toBeDefined();
    });

    it('inflects a consonant-plus-y relationship verb into its -ies form', async () => {
      const custom = new RuleBasedExtractor({ relationshipVerbs: ['notify'] });
      const ep = userSays('Alice Smith notifies Acme Corp about every deployment.');

      const result = await custom.extract(ep);

      expect(result.relationships.find((r) => r.relation_type === 'notify')).toBeDefined();
    });
  });

  describe('output metadata', () => {
    it('returns Entity records whose ids match the ids referenced by facts', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      const entityIds = new Set(result.entities.map((e) => e.id));
      for (const fact of result.facts) {
        for (const eid of fact.entity_ids) {
          expect(entityIds.has(eid)).toBe(true);
        }
      }
    });

    it('sets fact provenance source to derived', async () => {
      const result = await extractor.extract(userSays(ALICE_ACME));

      expect(result.facts[0].provenance.source).toBe('derived');
    });

    it('sets entity provenance source to derived', async () => {
      const result = await extractor.extract(userSays(ALICE_ACME));

      for (const entity of result.entities) {
        expect(entity.provenance.source).toBe('derived');
      }
    });

    it('sets fact valid_from to the episode started_at', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      expect(result.facts[0].valid_from).toEqual(ep.started_at);
    });

    it('sets relationship valid_from to the episode started_at', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      for (const rel of result.relationships) {
        expect(rel.valid_from).toEqual(ep.started_at);
      }
    });

    it('sets the episode fact_ids back-link to the extracted facts', async () => {
      const ep = userSays(ALICE_ACME);

      const result = await extractor.extract(ep);

      expect(ep.fact_ids).toEqual(result.facts.map((f) => f.id));
    });

    it('returns no entities or relationships for an empty message', async () => {
      const result = await extractor.extract(userSays(''));

      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });
  });
});
