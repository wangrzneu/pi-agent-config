/**
 * Detect verbal loops in a streamed assistant output: the model repeats the
 * same sentence or phrase over and over (for example stuck emitting "Now run
 * lldb" without ever making the tool call) while making no progress.
 *
 * Detection is deliberately conservative — informed by Grok Build's doom-loop
 * design (`tail_repetition` detected on the thinking channel only, high
 * threshold before acting):
 *
 * - A phrase must appear as an exact, whitespace-normalized duplicate at least
 *   `maxRepeatedPhrases` times inside a bounded recent window.
 * - The two channels are counted separately: `thinking` repetitions (the
 *   "stuck thinking" case) use a lower default threshold than `text`
 *   repetitions (visible output, where a false positive is far more
 *   disruptive).
 * - Phrases shorter than `minPhraseLength` or without at least two letters
 *   (e.g. "=====", "111 222", "a") are ignored — they are not meaningful
 *   repetition signal.
 * - Only prose clauses count: a segment must be bounded by clause-level
 *   punctuation (sentence finals, commas, line breaks), contain no
 *   structural punctuation (quotes, backticks, parens, brackets, braces),
 *   and — unless CJK — span at least two words. Code fragments and bare
 *   identifiers (e.g. `omitempty`, `ContentItem`, `err := f()`) are not
 *   repetition signal.
 *
 * Callers decide the action on detection (abort vs prompt) — this module only
 * reports that a confident repetition was seen.
 */

export interface OutputLoopOptions {
  /** Same phrase appearing this many times in the window triggers a loop. */
  maxRepeatedPhrases?: number;
  /**
   * Threshold used for the `thinking` channel when `maxRepeatedPhrases` is
   * not explicitly set. Thinking repetitions are the strongest "stuck" signal
   * (the model cycles internally without producing user-visible output), so
   * the default is lower (more sensitive) than the text channel.
   */
  maxRepeatedPhrasesThinking?: number;
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
  maxRepeatedPhrases: 10,
  maxRepeatedPhrasesThinking: 5,
  minPhraseLength: 8,
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
 * clause-level punctuation (sentence finals, commas, line breaks). Whitespace
 * is normalized so streaming token boundaries do not break a phrase.
 *
 * Deliberately conservative about code — a phrase is repetition signal only
 * if it is a prose clause:
 * - Segments without at least two letters (Latin or CJK) are dropped — they
 *   are code/separator noise, not repetition signal.
 * - Segments containing structural punctuation (quotes, backticks, parens,
 *   brackets) are code fragments, not clauses: a Go struct tag like
 *   `json:"return_last_frame,omitempty"` stays bound to its field line and
 *   never sheds identical `omitempty` fragments across fields; call-site
 *   prefixes and `return ""` tails are filtered the same way.
 * - Bare single-token ASCII phrases (identifiers such as `ContentItem`,
 *   `default_timeout`) are dropped, while pure CJK phrases count as single
 *   tokens — the script has no word spaces, so a stuck `请执行第一步操作。`
 *   loop must still fire.
 */
export function extractPhrases(text: string, minLength = 4): string[] {
  const parts = text.split(/[。．！？!?；;，,·…\n\r.]+/);
  const phrases: string[] = [];
  for (const part of parts) {
    const normalized = part.replace(/\s+/g, " ").trim();
    if (normalized.length < minLength) continue;
    if (letterCount(normalized) < 2) continue;
    if (!isProseClause(normalized)) continue;
    if (!isRepeatSignal(normalized)) continue;
    phrases.push(normalized);
  }
  return phrases;
}

/**
 * Structural punctuation marks a segment as code or quoted text, not a
 * repeatable prose clause: quotes in all flavors (plus backtick) and every
 * bracket form are exactly what struct tags, JSON, call sites, and string
 * literals are built from. Non-ASCII quotes are included so quoted speech
 * behaves the same way; apostrophes (`'`, `’`) are deliberately NOT included
 * so English contractions keep working.
 */
const STRUCTURAL_PUNCTUATION = /["“”‘’`()\[\]（）{}【】「」『』]/u;

function isProseClause(phrase: string): boolean {
  return !STRUCTURAL_PUNCTUATION.test(phrase);
}

/**
 * A phrase is repetition signal only if it is more than a bare ASCII
 * identifier. Pure-ASCII phrases must span at least two whitespace-separated
 * tokens (sentences/clauses); CJK phrases are valid single tokens because the
 * script does not use word spaces. This filters repeated identifiers and
 * struct-tag fragments that code listings legitimately repeat.
 */
function isRepeatSignal(phrase: string): boolean {
  if (hasCJK(phrase)) return true;
  return phrase.split(/\s+/).length >= 2;
}

function hasCJK(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function letterCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/\p{L}/u.test(char)) count += 1;
  }
  return count;
}
