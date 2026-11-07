/**
 * Optional reproducible runs: open index.html?seed=42 to replace Math.random with a
 * seeded PRNG (mulberry32). Without a seed parameter, nothing changes.
 */
(function () {
  const match = /[?&]seed=([^&#]+)/.exec(window.location.search);
  if (!match) return;

  // Hash the seed string to a 32-bit integer (FNV-1a)
  let h = 0x811c9dc5;
  for (const ch of decodeURIComponent(match[1])) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  let state = h >>> 0;
  Math.random = function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  console.log(`[seed] Math.random seeded with "${decodeURIComponent(match[1])}"`);
})();
