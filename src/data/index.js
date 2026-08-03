/**
 * Dex data.
 *
 * `sample-*.js` is a hand-checked subset so the app runs on a fresh clone with
 * no build step. Running `npm run refresh-dex` writes the full ~1300-entry
 * dataset to `src/data/pokedex.json` + `moves.json`, and this module picks it
 * up automatically.
 *
 * NEVER call PokeAPI at runtime. See CLAUDE.md.
 */

import { SAMPLE_POKEDEX } from "./sample-pokedex.js";
import { SAMPLE_MOVES } from "./sample-moves.js";

let POKEDEX = SAMPLE_POKEDEX;
let MOVES = SAMPLE_MOVES;
let usingFullDex = false;

// Vite resolves this at build time; the ?? keeps it optional so a fresh clone
// without generated data still builds.
try {
  const dex = Object.values(
    import.meta.glob("./pokedex.json", { eager: true, import: "default" })
  )[0];
  const mv = Object.values(
    import.meta.glob("./moves.json", { eager: true, import: "default" })
  )[0];
  if (Array.isArray(dex) && dex.length) {
    POKEDEX = dex.filter((p) => !p.isAltForm);
    usingFullDex = true;
  }
  if (Array.isArray(mv) && mv.length) MOVES = mv;
} catch {
  // Generated data absent — sample set stands in.
}

export { POKEDEX, MOVES, usingFullDex };

export const byId = (id) => POKEDEX.find((p) => p.id === id);
export const moveByName = (name) => MOVES.find((m) => m.name === name);
