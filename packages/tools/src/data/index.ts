/**
 * Data tools: pure, dependency-light computation.
 *
 * @module data
 */

export { calculatorTool } from './calculator.js';
export type { CalculatorToolOptions } from './calculator.js';
export { jsonTransformTool } from './json-transform.js';
export type { JsonTransformToolOptions } from './json-transform.js';
export { currentTimeTool } from './current-time.js';
export type { CurrentTimeToolOptions } from './current-time.js';
export { csvParseTool, parseCsv } from './csv-parse.js';
export type { CsvParseToolOptions } from './csv-parse.js';
export { statsTool } from './stats.js';
export type { StatsToolOptions } from './stats.js';
export { textExtractTool } from './text-extract.js';
export type { TextExtractToolOptions, ExtractedMatch } from './text-extract.js';
