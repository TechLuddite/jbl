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

/**
 * The descriptive layer the Pokédex tab reads: the bio, the vital statistics,
 * the evolution chains and every ability's real name and description. Baked by
 * `npm run refresh-species`, optional like the rest — without it the Pokédex
 * still shows types, stats, matchups and moves, just no bio.
 */
let SPECIES = {};
let CHAINS = {};
let ABILITY_INFO = {};
let usingSpeciesData = false;

try {
  const file = Object.values(
    import.meta.glob("./species.json", { eager: true, import: "default" })
  )[0];
  if (file?.species) {
    SPECIES = file.species;
    CHAINS = file.chains ?? {};
    usingSpeciesData = true;
  }
  const abilities = Object.values(
    import.meta.glob("./abilities.json", { eager: true, import: "default" })
  )[0];
  if (abilities) ABILITY_INFO = abilities;
} catch {
  // Not baked yet — the Pokédex degrades to what pokedex.json already knows.
}

/**
 * Official artwork — the big painted picture, not the 96px sprite. Same repo
 * the sprites already come from. Kept in step with ART_BASE in
 * scripts/build-species.mjs, which asserts against the live URL at bake time.
 * `art` is false where PokéAPI has no artwork, and the sprite stands in.
 */
const ART_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork";

export { POKEDEX, MOVES, ALL_MOVES, usingFullDex, usingSpeciesData };

/** Everything species.json knows about one Pokémon, or null. */
export const speciesOf = (pokemon) => (pokemon ? SPECIES[pokemon.id] ?? null : null);

/** The evolution line a Pokémon belongs to, oldest stage first. [] if unknown. */
export const chainOf = (pokemon) => {
  const chain = speciesOf(pokemon)?.chain;
  return chain != null ? CHAINS[chain] ?? [] : [];
};

/** A big picture if there is one, the battle sprite if there isn't. */
export const artworkFor = (pokemon) =>
  speciesOf(pokemon)?.art ? `${ART_BASE}/${pokemon.id}.png` : pokemon?.sprite ?? null;

/**
 * An ability's real name and in-game description. Falls back to un-slugifying
 * the name so an unbaked clone shows "Solar Power" rather than
 * "solar-power" — but never invents a description.
 */
export const abilityInfo = (slug) =>
  ABILITY_INFO[slug] ?? {
    name: slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    desc: null,
  };

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
