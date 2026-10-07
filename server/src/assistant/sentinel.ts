/**
 * Streaming-safe sentinel parser.
 *
 * The real model streams a natural answer that ends with a machine-readable
 * line:  <<<META intent=<intent> confidence=<0-1>>>
 *
 * The gateway must (a) never forward the sentinel to the client, and (b)
 * survive chunk boundaries that split the marker mid-way. SentinelFilter holds
 * back any trailing partial-marker prefix until it can be resolved, and
 * collects the meta tail for parsing at finish().
 */

export const MARKER = '<<<META';
const META_RE = /intent=([a-z_]+)\s+confidence=([0-9]*\.?[0-9]+)/i;

export interface SentinelMeta {
  intent: string;
  confidence: number;
}

export class SentinelFilter {
  private hold = ''; // trailing text that might be a partial marker prefix
  private inMeta = false;
  private metaBuf = '';
  sawAnyText = false;

  /** Feed a backend delta; returns client-safe text ('' when held back). */
  push(text: string): string {
    this.sawAnyText ||= text.trim().length > 0;
    if (this.inMeta) {
      this.metaBuf += text;
      return '';
    }
    let buf = this.hold + text;
    this.hold = '';
    const idx = buf.indexOf(MARKER);
    if (idx >= 0) {
      this.inMeta = true;
      this.metaBuf = buf.slice(idx + MARKER.length);
      return buf.slice(0, idx);
    }
    // hold back a trailing partial prefix of the marker (e.g. answer ends "...")
    for (let keep = Math.min(MARKER.length - 1, buf.length); keep > 0; keep--) {
      if (MARKER.startsWith(buf.slice(-keep))) {
        this.hold = buf.slice(-keep);
        buf = buf.slice(0, buf.length - keep);
        break;
      }
    }
    return buf;
  }

  /**
   * Close the stream. Returns leftover client text (held-back tail when no
   * marker ever appeared) and the parsed meta, or null when the model output
   * was unusable (missing/malformed sentinel) — the caller degrades to the
   * retrieval vote instead of guessing.
   */
  finish(): { tail: string; meta: SentinelMeta | null } {
    const tail = this.inMeta ? '' : this.hold;
    this.hold = '';
    if (!this.inMeta) return { tail, meta: null };
    const m = META_RE.exec(this.metaBuf);
    if (!m) return { tail, meta: null };
    const confidence = Math.min(1, Math.max(0, Number(m[2])));
    if (Number.isNaN(confidence)) return { tail, meta: null };
    return { tail, meta: { intent: m[1]!.toLowerCase(), confidence } };
  }
}
