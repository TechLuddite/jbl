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
let ALL_MOVES = SAMPLE_MOVES;
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
  if (Array.isArray(mv) && mv.length) ALL_MOVES = mv;
} catch {
  // Generated data absent — sample set stands in.
}

// The damage calculator only wants moves that deal damage; the sim wants
// everything, status moves included. The sample set is damaging-only, so on a
// fresh clone the two lists are identical.
const MOVES = ALL_MOVES.filter((m) => m.power != null && m.category !== "status");

export { POKEDEX, MOVES, ALL_MOVES, usingFullDex };

export const byId = (id) => POKEDEX.find((p) => p.id === id);
export const moveByName = (name) => ALL_MOVES.find((m) => m.name === name);
export const moveById = (id) => ALL_MOVES.find((m) => m.id === id);

/**
 * Moves this Pokémon may pick in the sim. With the full dex baked, that's its
 * real learnset (latest game it appears in); the sample set has no learnset
 * data, so everything is legal — u-pick in the most literal sense.
 */
export const legalMoves = (pokemon) =>
  Array.isArray(pokemon?.learnset) && pokemon.learnset.length
    ? pokemon.learnset.map(moveById).filter(Boolean)
    : ALL_MOVES;
