// Greek → Greeklish for guest names ("Στέργιος" → "Stergios", "Άγγελος" → "Aggelos").
// Used by the guest page (as /greeklish.js) and by the server (src/app.js).

const PAIRS = { ου: 'ou', αυ: 'av', ευ: 'ev', ηυ: 'iv' };
const LETTERS = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

export function toGreeklish(text) {
  // Drop accents and diaeresis first (ά → α, ϊ → ι).
  const plain = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
  let out = '';
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    const lower = ch.toLowerCase();
    const pair = PAIRS[lower + (plain[i + 1] || '').toLowerCase()];
    const latin = pair || LETTERS[lower];
    if (!latin) { out += ch; continue; }
    if (pair) i++;
    // Keep capitals: Θ → Th, ΘΕΟΣ stays upper case.
    const upper = ch !== lower;
    const nextUpper = /\p{Lu}/u.test(plain[i + 1] || '');
    out += upper ? (nextUpper ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1)) : latin;
  }
  return out;
}

// A name the DJ can read: Greeklish, Latin letters, spaces, dots, apostrophes and hyphens.
export const isLatinName = (name) => /^[A-Za-z][A-Za-z .'-]*$/.test(name);
