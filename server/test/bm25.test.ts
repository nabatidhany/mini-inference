import { describe, expect, it } from 'vitest';
import { BM25Index, tokenize } from '../src/assistant/bm25.js';

const docs = [
  { id: 1, text: 'how do I recover my password recover_password' },
  { id: 2, text: 'I want to track my order status track_order' },
  { id: 3, text: 'where is my refund track_refund' },
  { id: 4, text: 'help me recover my account access recover_password' },
];

describe('tokenize', () => {
  it('lowercases, strips punctuation and drops stopwords', () => {
    expect(tokenize('How do I RECOVER, my password?!')).toEqual(['recover', 'password']);
  });
  it('returns empty for stopword-only input', () => {
    expect(tokenize('the a of to')).toEqual([]);
  });
});

describe('BM25Index', () => {
  const index = new BM25Index(docs);

  it('ranks the matching document first', () => {
    const hits = index.search('recover my password');
    expect(hits[0]?.id).toBe(1);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns nothing for queries with no lexical overlap', () => {
    expect(index.search('penguin migration patterns')).toEqual([]);
  });

  it('scores are positive and descending', () => {
    const hits = index.search('recover password account');
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });
});
