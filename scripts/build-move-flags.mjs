#!/usr/bin/env node
/**
 * build-move-flags.mjs — bake the move flags PokéAPI doesn't publish.
 *
 * Run occasionally, commit the output, never fetch at runtime:
 *   npm run refresh-flags
 *
 * Why this exists at all: whether a move makes CONTACT decides Static, Flame
 * Body, Rough Skin, Rocky Helmet, Tough Claws and the punish riders on Spiky
 * Shield and King's Shield. PokéAPI's /move endpoint has no flags block, so
 * the sim had no way to know — which is why ROADMAP.md listed every one of
 * those as blocked. Pokémon Showdown publishes the flags as one static JSON
 * file, so we bake it the same way we bake the dex: once, offline, committed.
 *
 * Output: ./src/data/move-flags.json — { flagName: [slug, slug, ...] }, only
 * the flags the engine actually reads. Slugs are OUR slugs (PokéAPI's), mapped
 * across from Showdown's id form, so the file drops straight onto moves.json.
 *
 * If the fetch fails, the committed file is left exactly as it is. A stale
 * flags file costs you flags on brand-new moves; a half-written one would
 * silently turn Static off.
 */

import { readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://play.pokemonshowdown.com/data/moves.json";
const OUT = "./src/data/move-flags.json";

/**
 * The flags the sim reads. Anything not on this list is dropped, so the file
 * stays small and every entry has something behind it.
 */
const WANTED = [
  "contact",  // Static, Flame Body, Rough Skin, Rocky Helmet, Tough Claws...
  "punch",    // Iron Fist
  "bite",     // Strong Jaw
  "sound",    // Soundproof, Punk Rock
  "powder",   // Safety Goggles, Overcoat, and Grass types shrugging off Spore
  "bullet",   // Bulletproof
  "pulse",    // Mega Launcher
  "slicing",  // Sharpness
  "wind",     // Wind Rider
  "heal",     // Triage
];

/**
 * Showdown ids are our slugs with the punctuation removed, so the mapping is
 * mechanical. `vice-grip` is the one name the two datasets spell differently.
 */
const showdownId = (slug) =>
  ({ "vice-grip": "visegrip" })[slug] ?? slug.replace(/[^a-z0-9]/g, "");

async function main() {
  const moves = JSON.parse(await readFile("./src/data/moves.json", "utf8"));

  console.log(`Fetching move flags from ${SOURCE}...`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${res.status} ${SOURCE}`);
  const showdown = await res.json();

  const out = Object.fromEntries(WANTED.map((f) => [f, []]));
  const unmatched = [];
  for (const move of moves) {
    const entry = showdown[showdownId(move.slug)];
    if (!entry) {
      unmatched.push(move.slug);
      continue;
    }
    for (const flag of WANTED) {
      if (entry.flags?.[flag]) out[flag].push(move.slug);
    }
  }

  for (const flag of WANTED) out[flag].sort();

  await writeFile(OUT, JSON.stringify(out, null, 1));
  for (const flag of WANTED) console.log(`  ${flag}: ${out[flag].length}`);
  console.log(`Wrote ${OUT}`);
  if (unmatched.length) {
    // Z-moves and the Colosseum/XD Shadow moves live in our dataset but not in
    // Showdown's. Nothing learns them, so an empty flag set is correct.
    console.log(`\n${unmatched.length} moves had no Showdown entry (Z-moves and Shadow moves):`);
    console.log(`  ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? ", ..." : ""}`);
  }
}

main().catch((err) => {
  console.error("Flag bake failed — leaving the committed file alone:", err.message);
  process.exit(1);
});
