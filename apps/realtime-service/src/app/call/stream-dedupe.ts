const STREAM_ID_RE = /^\d+-\d+$/;

// Redis stream ids are monotonic `<ms>-<seq>`. Returns <0, 0, >0.
export function compareStreamIds(a: string, b: string): number {
  const [am, as_] = a.split('-');
  const [bm, bs] = b.split('-');
  const dm = Number(am) - Number(bm);
  if (dm !== 0) return dm;
  return Number(as_) - Number(bs);
}

/**
 * Monotonic stream-id de-duplicator. Returns a predicate that answers "emit
 * this event?": true the first time, false for any stream-id at or below one
 * already seen (replay + live buffer overlap on reconnect). Events without a
 * real stream id (synthesized control frames, interim events) always pass.
 */
export function makeStreamDeduper(): (id: string | undefined) => boolean {
  let last: string | null = null;
  return (id) => {
    if (typeof id !== 'string' || !STREAM_ID_RE.test(id)) return true;
    if (last !== null && compareStreamIds(id, last) <= 0) return false;
    last = id;
    return true;
  };
}
