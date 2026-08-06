/**
 * Detect verbal loops in a streamed assistant output: the model repeats the
 * same sentence or phrase over and over (for example stuck emitting "Now run
 * lldb" without ever making the tool call) while making no progress.
 *
 * Detection is deliberately conservative: a phrase must appear as an exact,
 * whitespace-normalized duplicate at least `maxRepeatedPhrases` times inside a
 * bounded recent window. Diverse prose never fires; repetitive code blocks can
 * occasionally match, but the extension asks before aborting, so a false
 * positive is recoverable.
 */

export interface OutputLoopOptions {
  /** Same phrase appearing this many times in the window triggers a loop. */
  maxRepeatedPhrases?: number;
  /** Phrases shorter than this many characters are ignored. */
  minPhraseLength?: number;
  /** Recent text window (characters) over which repeats are measured. */
  windowChars?: number;
  /** Minimum new text between analyses (throttle for token streaming). */
  analyzeEveryChars?: number;
}

export interface OutputLoopDetection {
  kind: "phrase-repeat";
  phrase: string;
  count: number;
}

export const DEFAULT_OUTPUT_LOOP_OPTIONS: Required<OutputLoopOptions> = {
  maxRepeatedPhrases: 6,
  minPhraseLength: 4,
  windowChars: 2000,
  analyzeEveryChars: 16,
};

export class OutputLoopDetector {
  private buffer = "";
  /** Total characters fed so far (monotonic; unaffected by window slicing). */
  private fedChars = 0;
  /** fedChars at the last analysis, used as the throttle watermark. */
  private lastAnalyzedChars = 0;
  private readonly options: Required<OutputLoopOptions>;

  constructor(options: OutputLoopOptions = {}) {
    this.options = { ...DEFAULT_OUTPUT_LOOP_OPTIONS, ...options };
  }

  reset(): void {
    this.buffer = "";
    this.fedChars = 0;
    this.lastAnalyzedChars = 0;
  }

  get outputChars(): number {
    return this.buffer.length;
  }

  /** Feed one streamed text delta; returns a detection once crossed. */
  feed(delta: string): OutputLoopDetection | undefined {
    if (delta.length === 0) return undefined;
    this.buffer += delta;
    if (this.buffer.length > this.options.windowChars) {
      this.buffer = this.buffer.slice(-this.options.windowChars);
    }
    this.fedChars += delta.length;
    if (this.fedChars - this.lastAnalyzedChars < this.options.analyzeEveryChars) {
      return undefined;
    }
    this.lastAnalyzedChars = this.fedChars;
    return this.analyze();
  }

  private analyze(): OutputLoopDetection | undefined {
    const { maxRepeatedPhrases, minPhraseLength } = this.options;
    const counts = new Map<string, number>();
    for (const phrase of extractPhrases(this.buffer, minPhraseLength)) {
      const count = (counts.get(phrase) ?? 0) + 1;
      if (count >= maxRepeatedPhrases) {
        return { kind: "phrase-repeat", phrase, count };
      }
      counts.set(phrase, count);
    }
    return undefined;
  }
}

/**
 * Split text into exact-repeatable units: sentence-like segments split on
 * sentence punctuation, line breaks, and common delimiters (CJK and Latin).
 * Whitespace is normalized so streaming token boundaries do not break a phrase.
 */
export function extractPhrases(text: string, minLength = 4): string[] {
  const parts = text.split(/[。．！？!?；;，,·…\n\r（）()\[\]「」.]+/);
  const phrases: string[] = [];
  for (const part of parts) {
    const normalized = part.replace(/\s+/g, " ").trim();
    if (normalized.length >= minLength) phrases.push(normalized);
  }
  return phrases;
}
