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

/**
 * Move flags (contact, punch, sound...) ride in from `move-flags.json`, baked
 * separately because PokéAPI doesn't publish them. Attaching them here means
 * every move object the app hands the sim already knows whether it touches —
 * which is what Static, Rocky Helmet and Iron Fist all key off.
 *
 * The sample moves have no slug, so they match on a slugified name instead.
 */
try {
  const flagFile = Object.values(
    import.meta.glob("./move-flags.json", { eager: true, import: "default" })
  )[0];
  if (flagFile) {
    const bySlug = new Map();
    for (const [flag, slugs] of Object.entries(flagFile)) {
      for (const slug of slugs) {
        if (!bySlug.has(slug)) bySlug.set(slug, []);
        bySlug.get(slug).push(flag);
      }
    }
    const slugOf = (m) => m.slug ?? m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    ALL_MOVES = ALL_MOVES.map((m) => ({ ...m, flags: bySlug.get(slugOf(m)) ?? [] }));
  }
} catch {
  // No flag file — moves simply carry no flags, and the abilities that read
  // them stay quiet rather than guessing.
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
