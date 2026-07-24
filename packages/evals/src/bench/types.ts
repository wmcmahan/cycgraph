/**
 * Compression Benchmark Types
 *
 * Contracts for the public-benchmark harness. The central abstraction is
 * {@link CompressorAdapter}: every engine — cycgraph presets, naive
 * baselines, external competitors (LLMLingua-2, ...) — implements the same
 * "context in, budgeted context out" contract, so all engines see the same
 * inputs, the same token budgets, the same reader model, and the same
 * metrics. Comparison is fair by construction.
 *
 * @module bench/types
 */

/** One document in a benchmark question's context. */
export interface BenchDocument {
  title: string;
  text: string;
}

/** One benchmark item: a question answerable from its context documents. */
export interface BenchQuestion {
  id: string;
  question: string;
  answer: string;
  /**
   * Alternate gold surface forms (e.g. MuSiQue's `answer_aliases`).
   * Scoring takes the max over `answer` + aliases, per the source
   * dataset's official protocol. Absent/empty for datasets without them.
   */
  answerAliases?: string[];
  documents: BenchDocument[];
}

/** What an adapter returns for one compression call. */
export interface CompressionOutput {
  /** The compressed context to hand to the reader model. */
  compressed: string;
  /** Tokens in the compressed output (measured by the shared counter). */
  outputTokens: number;
  /** Wall-clock compression time in milliseconds. */
  durationMs: number;
}

/**
 * A compression engine under benchmark. Implementations must be
 * deterministic for a given (question, budget) — seeded randomness only.
 */
export interface CompressorAdapter {
  /** Unique adapter name (appears in reports), e.g. 'cycgraph-balanced'. */
  readonly name: string;
  /** Engine/package version string for the report. */
  readonly version: string;
  /**
   * Whether this adapter can run in the current environment. External
   * engines (Python bridges) probe their runtime here; unavailable
   * adapters are reported as skipped, never silently omitted.
   */
  available(): Promise<boolean>;
  /**
   * Compress the question's context to fit the token budget. The question
   * itself is passed for query-aware engines; adapters that don't use it
   * must ignore it (documented per adapter).
   */
  compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput>;
}

/** Frozen benchmark configuration (committed before running). */
export interface BenchConfig {
  /** Dataset identifier, e.g. 'hotpotqa-distractor-dev'. */
  dataset: string;
  /** URL the raw dataset is fetched from. */
  datasetUrl: string;
  /**
   * Expected SHA-256 of the raw dataset file. When set, the loader
   * verifies the downloaded (or cached) file against it and refuses to
   * run on a mismatch — the raw data provably is what the config says.
   */
  datasetSha256?: string;
  /** Number of questions in the evaluation subset. */
  subsetSize: number;
  /** Seed for deterministic subset selection and random baselines. */
  seed: number;
  /**
   * Compression ratios to sweep, as fractions of the original context's
   * token count (0.5 = compress to half = 2x compression).
   */
  ratios: number[];
  /** Adapter names to run (must match registered adapters). */
  adapters: string[];
  /**
   * Matched-budget mode: name of the reference adapter. The reference runs
   * first at the target-ratio budgets; every other adapter then receives
   * the reference's ACHIEVED per-question token counts as its budget, so
   * all cells in a ratio group sit at identical achieved compression.
   * Without this, engines that overshoot their budget cap (compress more
   * than asked) are unfairly compared against engines that hit it exactly.
   * Omit for plain target-ratio budgets.
   */
  budgetReference?: string;
}

/** Per-question result for one adapter x ratio cell. */
export interface QuestionResult {
  questionId: string;
  exactMatch: number;
  f1: number;
  outputTokens: number;
  compressionMs: number;
}

/** Aggregated result for one adapter x ratio cell. */
export interface CellResult {
  adapter: string;
  /** Target ratio (1.0 for the no-compression ceiling). */
  ratio: number;
  /** Mean achieved ratio (outputTokens / originalTokens). */
  achievedRatio: number;
  meanExactMatch: number;
  meanF1: number;
  /** Paired mean F1 delta vs the no-compression ceiling. */
  f1DeltaVsNone: number;
  /** 95% confidence interval half-width for the paired delta. */
  f1DeltaCi95: number;
  meanCompressionMs: number;
  questions: QuestionResult[];
}

/** The full benchmark run output. */
export interface BenchReport {
  config: BenchConfig;
  /** SHA-256 of the canonicalized config — pins what was run. */
  configHash: string;
  /** SHA-256 of the evaluation subset file. */
  subsetHash: string;
  readerModel: string;
  startedAt: string;
  cells: CellResult[];
  /** Adapters that were requested but unavailable in this environment. */
  skippedAdapters: string[];
  /**
   * Engine version per adapter that ran (name → version). Absent in
   * artifacts produced before this field existed.
   */
  adapterVersions?: Record<string, string>;
}
