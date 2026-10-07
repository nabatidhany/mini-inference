import { describe, expect, it } from 'vitest';
import { SentinelFilter } from '../src/assistant/sentinel.js';

describe('SentinelFilter', () => {
  it('strips the sentinel from the client stream and parses it', () => {
    const f = new SentinelFilter();
    const out =
      f.push('To reset your password, open settings. ') +
      f.push('<<<META intent=recover_password confidence=0.9>>>');
    const { tail, meta } = f.finish();
    expect(out + tail).toBe('To reset your password, open settings. ');
    expect(meta).toEqual({ intent: 'recover_password', confidence: 0.9 });
  });

  it('survives chunk boundaries that split the marker mid-way', () => {
    const f = new SentinelFilter();
    let client = '';
    for (const chunk of ['Hello!', ' Nice answer.', '<<<ME', 'TA intent=', 'get_refund', ' conf', 'idence=0.7>>', '>']) {
      client += f.push(chunk);
    }
    const { tail, meta } = f.finish();
    expect(client + tail).toBe('Hello! Nice answer.');
    expect(meta).toEqual({ intent: 'get_refund', confidence: 0.7 });
  });

  it('degrades to null meta when the model never sends a sentinel', () => {
    const f = new SentinelFilter();
    const client = f.push('Some answer without any meta line.');
    const { tail, meta } = f.finish();
    expect(client + tail).toBe('Some answer without any meta line.');
    expect(meta).toBeNull();
  });

  it('degrades to null meta on a malformed sentinel', () => {
    const f = new SentinelFilter();
    const client = f.push('Answer.<<<META conf=high done>>>');
    const { tail, meta } = f.finish();
    expect(client + tail).toBe('Answer.');
    expect(meta).toBeNull();
  });

  it('holds back a trailing partial marker prefix, then flushes it', () => {
    const f = new SentinelFilter();
    const a = f.push('Answer ends with a comparison: 5 <');
    expect(a).toBe('Answer ends with a comparison: 5 ');
    const { tail, meta } = f.finish();
    expect(tail).toBe('<');
    expect(meta).toBeNull();
  });

  it('clamps confidence into [0,1]', () => {
    const f = new SentinelFilter();
    f.push('A.<<<META intent=review confidence=7.5>>>');
    expect(f.finish().meta?.confidence).toBe(1);
  });
});
