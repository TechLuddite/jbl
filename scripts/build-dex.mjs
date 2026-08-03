#!/usr/bin/env node
/**
 * build-dex.mjs — bake PokéAPI into a static dataset.
 *
 * Run once (takes ~10-20 min now that learnsets ride along), commit the
 * output, never call PokéAPI at runtime.
 *   node build-dex.mjs
 *
 * Why bake instead of fetching live:
 *   - PokéAPI is free and unmetered but explicitly asks you to cache locally.
 *     Hitting it per page view is rude and gets slow at ~1300 Pokémon.
 *   - The full dataset below is a few MB of JSON before gzip. Still fine.
 *   - Your app then works offline, which matters when a 12-year-old wants to
 *     use it in the car.
 *
 * Outputs:
 *   ./src/data/pokedex.json — every Pokémon: id, name, types, base stats,
 *                             sprite, abilities, learnset (move ids)
 *   ./src/data/moves.json   — EVERY move, status moves included: type, power,
 *                             accuracy, PP, priority, category, effect meta
 *
 * Learnsets use the LATEST version group each Pokémon appears in (usually
 * Scarlet/Violet; older Pokémon fall back to their most recent game). They are
 * stored as arrays of move ids to keep the file small — resolve them through
 * moves.json.
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

/**
 * Version groups in release order, slug → rank. PokéAPI ids are already
 * chronological, so the id doubles as the rank.
 */
async function buildVersionGroupRanks() {
  const index = await getJSON(`${API}/version-group?limit=100`);
  const ranks = {};
  for (const vg of index.results) {
    const id = Number(vg.url.replace(/\/$/, "").split("/").pop());
    ranks[vg.name] = id;
  }
  return ranks;
}

async function buildMoves() {
  console.log("Fetching move index...");
  const index = await getJSON(`${API}/move?limit=20000`);

  console.log(`Fetching ${index.results.length} moves...`);
  const raw = await pool(index.results, CONCURRENCY, async (entry) => {
    const m = await getJSON(entry.url);
    const effect =
      m.effect_entries?.find((e) => e.language.name === "en")?.short_effect ??
      null;
    return {
      id: m.id,
      slug: m.name,
      name: titleCase(m.name),
      type: m.type.name,
      power: m.power,
      accuracy: m.accuracy, // null = never misses
      pp: m.pp,
      category: m.damage_class.name, // physical | special | status
      priority: m.priority,
      target: m.target?.name ?? null,
      effectChance: m.effect_chance,
      effect: effect
        ? effect.replaceAll("$effect_chance", String(m.effect_chance ?? ""))
        : null,
      // The sim engine reads these. meta is null for a handful of moves.
      meta: m.meta
        ? {
            category: m.meta.category?.name ?? null,
            ailment: m.meta.ailment?.name ?? "none",
            ailmentChance: m.meta.ailment_chance,
            critRate: m.meta.crit_rate,
            drain: m.meta.drain, // % of damage healed (negative = recoil)
            healing: m.meta.healing, // % of max HP restored
            flinchChance: m.meta.flinch_chance,
            minHits: m.meta.min_hits,
            maxHits: m.meta.max_hits,
          }
        : null,
      statChanges: (m.stat_changes ?? []).map((s) => ({
        stat: STAT_KEYS[s.stat.name] ?? s.stat.name,
        change: s.change,
      })),
    };
  });

  return raw.sort((a, b) => a.id - b.id);
}

async function buildPokedex(moveIdBySlug, vgRanks) {
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

    // Learnset = every move learnable in the latest version group this
    // Pokémon has data for, regardless of method (level/TM/tutor/egg).
    let latestRank = -1;
    for (const mv of p.moves) {
      for (const d of mv.version_group_details) {
        const rank = vgRanks[d.version_group.name] ?? -1;
        if (rank > latestRank) latestRank = rank;
      }
    }
    const learnset = [];
    for (const mv of p.moves) {
      const inLatest = mv.version_group_details.some(
        (d) => (vgRanks[d.version_group.name] ?? -1) === latestRank
      );
      const id = moveIdBySlug[mv.move.name];
      if (inLatest && id != null) learnset.push(id);
    }
    learnset.sort((a, b) => a - b);

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
      abilities: p.abilities
        .sort((a, b) => a.slot - b.slot)
        .map((a) => ({ slug: a.ability.name, hidden: a.is_hidden })),
      learnset,
      // Forms above id 10000 are alternate forms (Mega, regional, etc).
      isAltForm: p.id > 10000,
    };
  });

  // Sort by dex number so the UI reads like a real Pokédex.
  raw.sort((a, b) => a.id - b.id);
  return raw;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const vgRanks = await buildVersionGroupRanks();

  const moves = await buildMoves();
  await writeFile(`${OUT}/moves.json`, JSON.stringify(moves));
  console.log(`Wrote ${moves.length} moves to ${OUT}/moves.json`);

  const moveIdBySlug = Object.fromEntries(moves.map((m) => [m.slug, m.id]));
  const dex = await buildPokedex(moveIdBySlug, vgRanks);
  await writeFile(`${OUT}/pokedex.json`, JSON.stringify(dex));
  console.log(`Wrote ${dex.length} Pokémon to ${OUT}/pokedex.json`);

  console.log("\nDone. Commit ./src/data and never call PokéAPI at runtime again.");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
