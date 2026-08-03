#!/usr/bin/env node
/**
 * build-dex.mjs — bake PokéAPI into a static dataset.
 *
 * Run once (takes ~5-10 min), commit the output, never call PokéAPI at runtime.
 *   node build-dex.mjs
 *
 * Why bake instead of fetching live:
 *   - PokéAPI is free and unmetered but explicitly asks you to cache locally.
 *     Hitting it per page view is rude and gets slow at ~1300 Pokémon.
 *   - The full dataset below is ~1.5MB of JSON. That's nothing. Ship it.
 *   - Your app then works offline, which matters when a 12-year-old wants to
 *     use it in the car.
 *
 * Outputs:
 *   ./src/data/pokedex.json  — every Pokémon: id, name, types, base stats, sprite
 *   ./src/data/moves.json    — damaging moves: name, type, power, category
 */

import { writeFile, mkdir } from "node:fs/promises";

const API = "https://pokeapi.co/api/v2";
const CONCURRENCY = 8; // be polite
const OUT = "./src/data";

// Sprites live in a separate GitHub repo. These URLs are stable and CDN-backed,
// so you can hotlink them rather than downloading ~1300 images.
const SPRITE_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

async function getJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with a fixed concurrency ceiling. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      if (i % 50 === 0) process.stdout.write(`  ...${i}/${items.length}\n`);
    }
  });
  await Promise.all(runners);
  return results;
}

const STAT_KEYS = {
  hp: "hp",
  attack: "atk",
  defense: "def",
  "special-attack": "spa",
  "special-defense": "spd",
  speed: "spe",
};

function titleCase(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function buildPokedex() {
  console.log("Fetching Pokémon index...");
  const index = await getJSON(`${API}/pokemon?limit=20000`);

  console.log(`Fetching ${index.results.length} Pokémon...`);
  const raw = await pool(index.results, CONCURRENCY, async (entry) => {
    const p = await getJSON(entry.url);
    const stats = {};
    for (const s of p.stats) {
      const key = STAT_KEYS[s.stat.name];
      if (key) stats[key] = s.base_stat;
    }
    return {
      id: p.id,
      slug: p.name,
      name: titleCase(p.name),
      types: p.types
        .sort((a, b) => a.slot - b.slot)
        .map((t) => t.type.name),
      stats,
      bst: Object.values(stats).reduce((a, b) => a + b, 0),
      sprite: `${SPRITE_BASE}/${p.id}.png`,
      // Forms above id 10000 are alternate forms (Mega, regional, etc).
      isAltForm: p.id > 10000,
    };
  });

  // Sort by dex number so the UI reads like a real Pokédex.
  raw.sort((a, b) => a.id - b.id);
  return raw;
}

async function buildMoves() {
  console.log("Fetching move index...");
  const index = await getJSON(`${API}/move?limit=20000`);

  console.log(`Fetching ${index.results.length} moves...`);
  const raw = await pool(index.results, CONCURRENCY, async (entry) => {
    const m = await getJSON(entry.url);
    return {
      slug: m.name,
      name: titleCase(m.name),
      type: m.type.name,
      power: m.power,
      accuracy: m.accuracy,
      pp: m.pp,
      category: m.damage_class.name, // physical | special | status
      priority: m.priority,
    };
  });

  // Damaging moves only — a damage calculator has no use for Swords Dance.
  return raw
    .filter((m) => m.power != null && m.category !== "status")
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const dex = await buildPokedex();
  await writeFile(`${OUT}/pokedex.json`, JSON.stringify(dex));
  console.log(`Wrote ${dex.length} Pokémon to ${OUT}/pokedex.json`);

  const moves = await buildMoves();
  await writeFile(`${OUT}/moves.json`, JSON.stringify(moves));
  console.log(`Wrote ${moves.length} damaging moves to ${OUT}/moves.json`);

  console.log("\nDone. Commit ./src/data and never call PokéAPI at runtime again.");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
