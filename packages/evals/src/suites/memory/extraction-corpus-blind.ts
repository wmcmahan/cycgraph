/**
 * Implementation-Blind Extraction Corpus
 *
 * Natural-text passages with meaning-space labels, for honest capability
 * measurement of BOTH extraction tiers — as opposed to the authored corpus
 * in extraction-corpus.ts, which is a regression fence fitted to the
 * rule-based implementation's envelope.
 *
 * PROTOCOL (recorded for auditability):
 * - Content-first sourcing: passages were written as news-brief / review /
 *   incident-report style prose about fictional people and organizations,
 *   drafted as narrative scenarios — NOT as showcases for or against any
 *   detector. Natural prose brings its own constructions (appositives,
 *   coreference, passives, lists, lowercase technical nouns, unicode names)
 *   without anyone hand-picking them.
 * - Meaning-space labels: ground truth records what each PASSAGE asserts,
 *   written from reading the text. Acceptance sets list surface forms and
 *   verb stems, deliberately broad, so no tier is graded against the other
 *   tier's canonical vocabulary. Relationship matching is
 *   DIRECTION-AGNOSTIC in v1 (does the extractor capture the assertion at
 *   all); direction scoring is a future refinement.
 * - Recall-focused: only labeled assertions are scored. Open precision is
 *   deliberately NOT measured against this corpus — natural text contains
 *   many defensible edges the labels don't enumerate, and punishing
 *   unlabeled-but-valid edges would penalize recall-rich extractors.
 *   Fabrication is covered by `forbidAffirmative` (assertions the text
 *   explicitly negates) and by the authored corpus's safety fences.
 * - Frozen before first contact: this file was completed BEFORE any scorer
 *   existed or either extractor ran against it, and is append-only
 *   afterward — labels are never edited to move a score.
 * - Blindness caveat, stated honestly: the author of these passages has
 *   read both implementations. That is weaker than third-party sourcing
 *   (e.g. sampled Wikipedia text), but it removes the main distortion in
 *   the authored corpus — case selection fitted to known behavior. For
 *   gold-standard blindness, have a second person label a slice
 *   independently and measure agreement.
 *
 * @module suites/memory/extraction-corpus-blind
 */

/** An entity the passage mentions, with accepted surface forms. */
export interface BlindEntity {
  /** Any extracted name containing / contained by one of these counts. */
  forms: string[];
  /** Asserted only when unambiguous from the text. */
  type?: 'person' | 'organization';
}

/** A relationship the passage asserts, in meaning-space (direction-agnostic). */
export interface BlindRelationship {
  /** One endpoint's accepted surface forms. */
  a: string[];
  /** The other endpoint's accepted surface forms. */
  b: string[];
  /** Accepted verb stems (matched leniently against relation types). */
  verbs: string[];
}

/**
 * An assertion the passage explicitly negates: an AFFIRMATIVE edge between
 * the endpoints with one of these verb stems (and no negation/cessation
 * marker in its type) is a fabrication.
 */
export interface BlindForbid {
  a: string[];
  b: string[];
  verbs: string[];
}

export interface BlindPassage {
  id: string;
  /** Multi-sentence natural text — fed to the extractor as one episode. */
  text: string;
  entities: BlindEntity[];
  relationships?: BlindRelationship[];
  forbidAffirmative?: BlindForbid[];
}

export const BLIND_CORPUS: BlindPassage[] = [
  {
    id: 'blind-acquisition',
    text:
      'Meridian Software said on Tuesday that it has acquired Bluefin Analytics for an undisclosed sum. ' +
      "The deal, Meridian's third this year, gives the Austin-based company a foothold in retail forecasting. " +
      "Bluefin's forty employees will join Meridian's data division, which is led by Priya Raman. " +
      'Founded in 2019, Bluefin counts Harborline Grocers among its largest customers.',
    entities: [
      { forms: ['Meridian Software', 'Meridian'], type: 'organization' },
      { forms: ['Bluefin Analytics', 'Bluefin'], type: 'organization' },
      { forms: ['Priya Raman'], type: 'person' },
      { forms: ['Harborline Grocers', 'Harborline'], type: 'organization' },
    ],
    relationships: [
      { a: ['Meridian'], b: ['Bluefin'], verbs: ['acquire', 'buy', 'purchase'] },
      { a: ['Priya Raman'], b: ['data division', 'Meridian'], verbs: ['lead', 'head', 'manage', 'run'] },
      { a: ['Harborline'], b: ['Bluefin'], verbs: ['customer', 'client', 'serve', 'supply', 'count'] },
    ],
  },
  {
    id: 'blind-hospital',
    text:
      'St. Alwyn Medical Center has appointed Dr. Marcus Webb as chief of cardiology, effective next month. ' +
      'Webb, who spent eleven years at Riverside General, replaces Dr. Elena Souza. ' +
      'Souza retired in March after three decades at the hospital. ' +
      'The cardiology department handles roughly four thousand patients a year.',
    entities: [
      { forms: ['St. Alwyn Medical Center', 'St. Alwyn'], type: 'organization' },
      { forms: ['Marcus Webb', 'Webb'], type: 'person' },
      { forms: ['Riverside General'], type: 'organization' },
      { forms: ['Elena Souza', 'Souza'], type: 'person' },
    ],
    relationships: [
      { a: ['Webb'], b: ['St. Alwyn'], verbs: ['appoint', 'hire', 'name', 'join', 'chief', 'work', 'lead'] },
      { a: ['Webb'], b: ['Riverside General'], verbs: ['work', 'spend', 'serve', 'spent'] },
      { a: ['Webb'], b: ['Souza'], verbs: ['replace', 'succeed'] },
      { a: ['Souza'], b: ['St. Alwyn', 'hospital'], verbs: ['retire', 'work', 'leave', 'serve'] },
    ],
  },
  {
    id: 'blind-research',
    text:
      'A team at Copperfield University has published new findings on battery degradation in cold climates. ' +
      'The study, which appeared in the Journal of Energy Materials, was funded by the Northern Grid Consortium. ' +
      'Lead author Dr. Yuki Tanaka credits her graduate students for the breakthrough. ' +
      'Copperfield plans to license the technology to manufacturers next year.',
    entities: [
      { forms: ['Copperfield University', 'Copperfield'], type: 'organization' },
      { forms: ['Journal of Energy Materials'] },
      { forms: ['Northern Grid Consortium'], type: 'organization' },
      { forms: ['Yuki Tanaka', 'Tanaka'], type: 'person' },
    ],
    relationships: [
      { a: ['Northern Grid Consortium'], b: ['study', 'Copperfield', 'research', 'findings'], verbs: ['fund', 'finance', 'sponsor'] },
      { a: ['Yuki Tanaka'], b: ['study', 'findings', 'research', 'Copperfield'], verbs: ['author', 'lead', 'write', 'work'] },
      { a: ['study', 'findings', 'Copperfield'], b: ['Journal of Energy Materials'], verbs: ['publish', 'appear'] },
    ],
  },
  {
    id: 'blind-restaurant',
    text:
      'Tucked behind the old ferry terminal, Salt & Ember serves a tasting menu that changes weekly. ' +
      'Chef Rosa Delgado, formerly of Copper Kettle, opened the restaurant with her brother in 2022. ' +
      'The wine list leans on small producers from Oregon. ' +
      'Reservations are hard to come by on weekends.',
    entities: [
      { forms: ['Salt & Ember', 'Salt and Ember'], type: 'organization' },
      { forms: ['Rosa Delgado', 'Delgado'], type: 'person' },
      { forms: ['Copper Kettle'], type: 'organization' },
    ],
    relationships: [
      { a: ['Rosa Delgado'], b: ['Copper Kettle'], verbs: ['work', 'chef', 'cook', 'former'] },
      { a: ['Rosa Delgado'], b: ['Salt & Ember', 'Salt and Ember', 'restaurant'], verbs: ['open', 'found', 'start', 'launch', 'own'] },
    ],
  },
  {
    id: 'blind-transfer',
    text:
      'Halcyon FC confirmed the signing of midfielder Teodor Vasquez from Atlético Marena on a four-year contract. ' +
      'Vasquez, twenty-four, scored eleven goals last season. ' +
      'He does not expect to be match-fit before the derby against Northgate United, the club said. ' +
      'Halcyon paid a fee reported to be around eight million.',
    entities: [
      { forms: ['Halcyon FC', 'Halcyon'], type: 'organization' },
      { forms: ['Teodor Vasquez', 'Vasquez'], type: 'person' },
      { forms: ['Atlético Marena', 'Atletico Marena'], type: 'organization' },
      { forms: ['Northgate United'], type: 'organization' },
    ],
    relationships: [
      { a: ['Vasquez'], b: ['Halcyon'], verbs: ['sign', 'join', 'hire', 'acquire', 'play', 'transfer'] },
      { a: ['Vasquez'], b: ['Atlético Marena', 'Atletico Marena'], verbs: ['play', 'leave', 'transfer', 'depart', 'from'] },
    ],
  },
  {
    id: 'blind-council',
    text:
      'The Brookhaven city council voted Thursday to extend the streetcar line to Milton Avenue. ' +
      'Council member Alicia Fontaine, who chairs the transit committee, sponsored the measure. ' +
      'Two members opposed it, citing cost overruns on the harbor tunnel project. ' +
      'Construction is expected to begin in the spring.',
    entities: [
      { forms: ['Brookhaven'], type: 'organization' },
      { forms: ['Alicia Fontaine', 'Fontaine'], type: 'person' },
      { forms: ['Milton Avenue'] },
      { forms: ['transit committee'] },
    ],
    relationships: [
      { a: ['Alicia Fontaine'], b: ['transit committee'], verbs: ['chair', 'lead', 'head'] },
      { a: ['Alicia Fontaine'], b: ['measure', 'Brookhaven', 'council'], verbs: ['sponsor', 'member', 'serve'] },
    ],
  },
  {
    id: 'blind-departure',
    text:
      'Corvid Labs announced that co-founder Sam Whitfield no longer works at the company. ' +
      "Whitfield, who built the firm's compiler team, left in June to start an unnamed venture. " +
      'He is not joining rival Datastrom, despite reports last week. ' +
      "Corvid's remaining founders said hiring for the compiler group will continue.",
    entities: [
      { forms: ['Corvid Labs', 'Corvid'], type: 'organization' },
      { forms: ['Sam Whitfield', 'Whitfield'], type: 'person' },
      { forms: ['Datastrom'], type: 'organization' },
    ],
    relationships: [
      { a: ['Whitfield'], b: ['Corvid'], verbs: ['found', 'cofound', 'co-found', 'start'] },
      { a: ['Whitfield'], b: ['compiler team', 'compiler'], verbs: ['build', 'lead', 'create'] },
    ],
    forbidAffirmative: [
      // "no longer works at the company" — a bare affirmative work_at is a
      // fabrication; negation/cessation phrasings are faithful.
      { a: ['Whitfield'], b: ['Corvid'], verbs: ['work'] },
      // "is not joining rival Datastrom"
      { a: ['Whitfield'], b: ['Datastrom'], verbs: ['join', 'work'] },
    ],
  },
  {
    id: 'blind-infra',
    text:
      'The checkout service depends on the payments gateway maintained by the platform group. ' +
      'When the gateway returns stale tokens, checkout retries against the backup cluster in Frankfurt. ' +
      'An incident on May 3rd was traced to a misconfigured cache, not to the gateway itself. ' +
      'The postmortem recommends moving token validation into the checkout service.',
    entities: [
      { forms: ['checkout service', 'checkout'] },
      { forms: ['payments gateway', 'gateway'] },
      { forms: ['platform group'] },
      { forms: ['Frankfurt'] },
    ],
    relationships: [
      { a: ['checkout'], b: ['gateway'], verbs: ['depend', 'rely', 'use'] },
      { a: ['platform group'], b: ['gateway'], verbs: ['maintain', 'own', 'manage'] },
    ],
    forbidAffirmative: [
      // "traced to a misconfigured cache, NOT to the gateway itself"
      { a: ['incident', 'May 3'], b: ['gateway'], verbs: ['cause', 'trace', 'due'] },
    ],
  },
];
