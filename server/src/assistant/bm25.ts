/**
 * BM25 (Okapi, Robertson & Zaragoza defaults k1=1.5, b=0.75) over the KB
 * questions. Tokenisation: lowercase, strip punctuation, drop English
 * stopwords. No stemming — a deliberate, measured cut (see REPORT.md).
 *
 * Indexing question text + intent tokens (e.g. "track_refund" -> "track
 * refund") gives the intent signal a lexical vote without any embedding.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'at',
  'by', 'for', 'with', 'about', 'into', 'to', 'from', 'in', 'on', 'out', 'up',
  'down', 'over', 'under', 'again', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'shall', 'may', 'might', 'must', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
  'them', 'their', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
  'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'too', 'very', 'just', 'there', 'here', 'as', 'am', 'until', 'while',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface Bm25Doc {
  id: number;
  text: string;
}

export interface Bm25Scored {
  id: number;
  score: number;
}

export class BM25Index {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly docTokens: string[][] = [];
  private readonly docIds: number[] = [];
  private readonly docLen: number[] = [];
  private readonly avgLen: number;
  private readonly df = new Map<string, number>(); // term -> doc frequency
  private readonly N: number;

  constructor(docs: Bm25Doc[]) {
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      this.docIds.push(doc.id);
      this.docTokens.push(tokens);
      this.docLen.push(tokens.length);
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          this.df.set(t, (this.df.get(t) ?? 0) + 1);
        }
      }
    }
    this.N = docs.length;
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / Math.max(1, this.N);
  }

  /** Rank all documents for a query; scores descending. */
  search(query: string): Bm25Scored[] {
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    const idf = (term: string): number => {
      const df = this.df.get(term) ?? 0;
      if (df === 0) return 0;
      return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
    };
    const tf = (tokens: string[], term: string): number => {
      let n = 0;
      for (const t of tokens) if (t === term) n++;
      return n;
    };
    const scores: Bm25Scored[] = [];
    for (let i = 0; i < this.N; i++) {
      const len = this.docLen[i] ?? 0;
      let s = 0;
      for (const term of qTerms) {
        const f = tf(this.docTokens[i] ?? [], term);
        if (f === 0) continue;
        const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + (this.b * len) / (this.avgLen || 1)));
        s += idf(term) * norm;
      }
      if (s > 0) scores.push({ id: this.docIds[i]!, score: s });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
  }
}
