#!/usr/bin/env node
/**
 * build-species.mjs — bake the Pokédex *details* from PokéAPI.
 *
 * Run manually, commit the output, never call PokéAPI at runtime:
 *   npm run refresh-species
 *
 * Why this is a second script rather than part of build-dex.mjs:
 *   build-dex.mjs owns the battle data — types, base stats, learnsets — and
 *   re-running it rewrites every learnset, which is a big, risky diff to take
 *   just to add a height. This script only ever touches the descriptive layer,
 *   so the two can be re-baked independently.
 *
 * Outputs:
 *   ./src/data/species.json   — per Pokémon: genus, the Pokédex bio and which
 *                               game it is quoted from, height, weight, gender
 *                               split, catch rate, egg groups, generation, the
 *                               level-up learnset, and its evolution chain id.
 *                               Plus every evolution chain, once each.
 *   ./src/data/abilities.json — every ability: its real name and its in-game
 *                               description.
 *
 * On the bio: it is quoted verbatim from the games, and species.json records
 * WHICH game each line came from so the app can say so. That is the whole
 * reason it is safe to show — it isn't a summary anybody wrote, it's the
 * Pokédex entry. Where a Pokémon has entries in several games we take the
 * most recent English one.
 *
 * Ids are Pokémon ids, not species ids. For every default form (everything at
 * or below 1025) those are the same number, and alternate forms don't get
 * details of their own.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { rankVersionGroups } from "./version-groups.mjs";

const API = "https://pokeapi.co/api/v2";
const CONCURRENCY = 8; // be polite
const OUT = "./src/data";

/**
 * `LIMIT=20 npm run refresh-species` bakes the first 20 of everything. A full
 * run is twenty-odd minutes, so this is how you check a change to the script
 * before committing to that — the output is a real file, so don't commit it.
 */
const LIMIT = Number(process.env.LIMIT) || Infinity;
const capped = (list) => (LIMIT === Infinity ? list : list.slice(0, LIMIT));

/**
 * Official artwork lives in the same sprite repo the dex already hotlinks.
 * This must stay in step with ART_BASE in src/data/index.js — the bake asserts
 * that the URL it builds is byte-for-byte the one PokéAPI reports, so a moved
 * path fails here rather than showing up as a broken image on a phone.
 */
const ART_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Run tasks with a fixed concurrency ceiling. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      if (i % 100 === 0) process.stdout.write(`  ...${i}/${items.length}\n`);
    }
  });
  await Promise.all(runners);
  return results;
}

const idFromUrl = (url) => Number(url.replace(/\/$/, "").split("/").pop());

function titleCase(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Pokédex text arrives wrapped to the width of a Game Boy screen, so it is
 * full of hard line breaks, form feeds where the text box paged, and soft
 * hyphens where a word was split across two lines. Unwrap it back into a
 * sentence without losing or inventing a character.
 */
export function cleanFlavor(text) {
  return text
    .replace(/\u00ad\n/g, "") // soft hyphen at a line break — rejoin the word
    .replace(/\u00ad/g, "")
    .replace(/-\n/g, "-") // real hyphen that happened to end a line
    .replace(/\f/g, " ") // form feed: the text box paged here
    .replace(/[\n\r]/g, " ")
    .replace(/\s+/g, " ")
    // Games up to Gen 4 shouted the word POKéMON. Everything else in those
    // entries is left exactly as written.
    .replace(/POK[Éé]MON/g, "Pokémon")
    .trim();
}

/**
 * Version name → release order. PokéAPI's version ids are chronological with
 * one exception: the Japan-only Gen 1 re-releases sit at the end of the list.
 * They carry no English text, but they are excluded by name so a future entry
 * can't quietly date a bio to 1996.
 */
async function buildVersionRanks() {
  const index = await getJSON(`${API}/version?limit=200`);
  const ranks = {};
  for (const v of index.results) {
    if (v.name.endsWith("-japan")) continue;
    ranks[v.name] = idFromUrl(v.url);
  }
  return ranks;
}

/**
 * Version group → release order, for ability text and level-up moves. Shares
 * version-groups.mjs with build-dex.mjs so a move's level and the learnset it
 * sits in always come from the same game.
 */
async function buildVersionGroupRanks() {
  const index = await getJSON(`${API}/version-group?limit=200`);
  return rankVersionGroups(index.results);
}

/** Proper English game names. PokéAPI slugs are lowercase and hyphenated. */
const GAME_NAME = {
  "lets-go-pikachu": "Let's Go, Pikachu!",
  "lets-go-eevee": "Let's Go, Eevee!",
  "omega-ruby": "Omega Ruby",
  "alpha-sapphire": "Alpha Sapphire",
  "ultra-sun": "Ultra Sun",
  "ultra-moon": "Ultra Moon",
  "firered": "FireRed",
  "leafgreen": "LeafGreen",
  "heartgold": "HeartGold",
  "soulsilver": "SoulSilver",
  "black-2": "Black 2",
  "white-2": "White 2",
  "brilliant-diamond": "Brilliant Diamond",
  "shining-pearl": "Shining Pearl",
  "legends-arceus": "Legends: Arceus",
  "legends-za": "Legends: Z-A",
  "the-isle-of-armor": "The Isle of Armor",
  "the-crown-tundra": "The Crown Tundra",
  "the-teal-mask": "The Teal Mask",
  "the-indigo-disk": "The Indigo Disk",
  x: "X",
  y: "Y",
  xd: "XD",
};

const gameName = (slug) =>
  GAME_NAME[slug] ??
  // Sword/Shield DLC versions come through as "the-teal-mask-scarlet".
  slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** Egg group slugs PokéAPI spells differently from the games. */
const EGG_GROUP_NAME = {
  plant: "Grass",
  humanshape: "Human-Like",
  "indeterminate": "Amorphous",
  ditto: "Ditto",
  "no-eggs": "No Eggs Discovered",
  water1: "Water 1",
  water2: "Water 2",
  water3: "Water 3",
};

const eggGroupName = (slug) => EGG_GROUP_NAME[slug] ?? titleCase(slug);

/* --------------------------------------------------------- evolutions ---- */

/**
 * Item, move and place names in evolution text. titleCase alone capitalises the
 * joining words and can't know about apostrophes, and these strings are read by
 * a person rather than looked up by a key, so they get spelled properly.
 */
const PROPER_NAME = {
  "kings-rock": "King's Rock",
  "up-grade": "Up-Grade",
  "deep-sea-tooth": "Deep Sea Tooth",
  "deep-sea-scale": "Deep Sea Scale",
};

const SMALL_WORDS = new Set(["of", "the", "and", "in", "on"]);

function properName(slug) {
  return (
    PROPER_NAME[slug] ??
    slug
      .split("-")
      .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ")
  );
}

/** "a Water Stone", but "an Ice Stone". */
const withArticle = (name) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

/**
 * Turn one PokéAPI evolution_details block into the sentence a player would
 * say. Every branch here is a condition the games actually use; anything this
 * doesn't recognise falls back to naming the trigger rather than inventing a
 * requirement.
 */
function describeEvolution(d) {
  const parts = [];
  const trigger = d.trigger?.name ?? "";
  const move = d.used_move ? properName(d.used_move.name) : "a move";
  const times = d.min_move_count ? `${d.min_move_count} times` : "enough times";

  if (trigger === "level-up") {
    parts.push(d.min_level ? `Level ${d.min_level}` : "Level up");
  } else if (trigger === "trade") {
    parts.push(d.trade_species ? `Trade for ${properName(d.trade_species.name)}` : "Trade");
  } else if (trigger === "use-item") {
    parts.push(d.item ? `Use ${withArticle(properName(d.item.name))}` : "Use an item");
  } else if (trigger === "shed") {
    parts.push("Level 20 with a spare Poké Ball and a free party slot");
  } else if (trigger === "spin") {
    parts.push("Spin around wearing Sweet");
  } else if (trigger === "tower-of-darkness") {
    parts.push("Train in the Tower of Darkness");
  } else if (trigger === "tower-of-waters") {
    parts.push("Train in the Tower of Waters");
  } else if (trigger === "three-critical-hits") {
    parts.push("Land three critical hits in one battle");
  } else if (trigger === "take-damage") {
    parts.push("Take 49 damage without fainting, then walk under the arch");
  } else if (trigger === "other") {
    parts.push("A special way");
  } else if (trigger === "use-move") {
    parts.push(`Use ${move} ${times}`);
  } else if (trigger === "agile-style-move") {
    parts.push(`Use ${move} in Agile Style ${times}`);
  } else if (trigger === "strong-style-move") {
    parts.push(`Use ${move} in Strong Style ${times}`);
  } else if (trigger === "recoil-damage") {
    parts.push(`Take ${d.min_damage_taken ?? "enough"} recoil damage`);
  } else if (trigger) {
    parts.push(titleCase(trigger));
  }

  // Extra conditions. `min_level` is already spoken for on a level-up, and
  // `used_move` on any of the move triggers.
  if (trigger !== "level-up" && d.min_level) parts.push(`at Level ${d.min_level}`);
  if (d.item && trigger !== "use-item") parts.push(`with ${withArticle(properName(d.item.name))}`);
  if (d.held_item) parts.push(`holding ${withArticle(properName(d.held_item.name))}`);
  if (d.known_move) parts.push(`knowing ${properName(d.known_move.name)}`);
  if (d.known_move_type) parts.push(`knowing ${withArticle(properName(d.known_move_type.name))} move`);
  if (d.min_happiness) parts.push("with high friendship");
  if (d.min_affection) parts.push("with high affection");
  if (d.min_beauty) parts.push("when beautiful enough");
  // The location is only ever named alongside the special rock, and it is the
  // rock that's the condition — the location is just where that game happens to
  // put one. Naming all six of them turns Leafeon's line into a paragraph.
  if (d.location && !d.near_special_rock) parts.push(`at ${properName(d.location.name)}`);
  if (d.time_of_day) parts.push(`at ${d.time_of_day.replace(/-/g, " ")}`);
  if (d.gender === 1) parts.push("if it's female");
  if (d.gender === 2) parts.push("if it's male");
  if (d.needs_overworld_rain) parts.push("while it's raining");
  if (d.turn_upside_down) parts.push("holding the console upside down");
  if (d.needs_multiplayer) parts.push("with another player");
  if (d.near_special_rock) parts.push("near a special rock");
  if (d.party_species) parts.push(`with ${properName(d.party_species.name)} in the party`);
  if (d.party_type) parts.push(`with ${withArticle(properName(d.party_type.name))} type in the party`);
  if (d.relative_physical_stats === 1) parts.push("with Attack above Defense");
  if (d.relative_physical_stats === 0) parts.push("with Attack equal to Defense");
  if (d.relative_physical_stats === -1) parts.push("with Attack below Defense");

  return parts.join(" ");
}

/**
 * Several games each name a different place for the same trick — Magnezone's
 * magnetic field is at Mt Coronet, Chargestone Cave, New Mauville and four
 * others. Listing all seven buries the answer a player wants, and every one of
 * them is the same condition wearing a different coat, so they collapse.
 */
export function condenseRoutes(hows) {
  const places = hows.filter((h) => /^Level up at /.test(h));
  if (places.length < 2) return hows;
  const rest = hows.filter((h) => !places.includes(h));
  return ["Level up somewhere special", ...rest];
}

/** Flatten a chain into a list, each entry remembering what it evolved from. */
function flattenChain(node, fromId = null, out = []) {
  const id = idFromUrl(node.species.url);
  // A stage can have several routes to it (Level 30, or a Water Stone).
  // Every distinct one is kept — picking one would be a lie about the other —
  // but the same route repeated once per game is just noise.
  const hows = condenseRoutes([
    ...new Set(node.evolution_details.map(describeEvolution).filter(Boolean)),
  ]);
  out.push({ id, name: titleCase(node.species.name), from: fromId, how: hows });
  for (const next of node.evolves_to) flattenChain(next, id, out);
  return out;
}

/* ------------------------------------------------------------- abilities -- */

async function buildAbilities(vgRanks) {
  console.log("Fetching ability index...");
  const index = await getJSON(`${API}/ability?limit=2000`);

  const list = capped(index.results);
  console.log(`Fetching ${list.length} abilities...`);
  const rows = await pool(list, CONCURRENCY, async (entry) => {
    const a = await getJSON(entry.url);
    const name = a.names?.find((n) => n.language.name === "en")?.name ?? titleCase(a.name);

    // The in-game description first — it's written for a player. The API's
    // own "short effect" is the fallback, and it's written for a developer.
    let best = null;
    let bestRank = -1;
    for (const f of a.flavor_text_entries ?? []) {
      if (f.language.name !== "en") continue;
      const rank = vgRanks[f.version_group?.name] ?? -1;
      if (rank > bestRank) { bestRank = rank; best = f.flavor_text; }
    }
    let desc = best ? cleanFlavor(best) : null;
    if (!desc) {
      const short = a.effect_entries?.find((e) => e.language.name === "en")?.short_effect;
      if (short) {
        desc = cleanFlavor(short).replaceAll("$effect_chance", String(a.effect_chance ?? ""));
      }
    }
    return [a.name, { name, desc: desc ?? null }];
  });

  return Object.fromEntries(rows.sort((a, b) => a[0].localeCompare(b[0])));
}

/* --------------------------------------------------------------- species -- */

async function buildSpecies(versionRanks, vgRanks) {
  console.log("Fetching species index...");
  const index = await getJSON(`${API}/pokemon-species?limit=20000`);

  const list = capped(index.results);
  console.log(`Fetching ${list.length} species...`);
  const chainUrls = new Map(); // chain id → url, fetched once each
  let oldBios = 0;
  let missingArt = 0;

  const rows = await pool(list, CONCURRENCY, async (entry) => {
    const s = await getJSON(entry.url);

    // The default variety is the Pokémon this species' details belong to.
    const variety = s.varieties?.find((v) => v.is_default) ?? s.varieties?.[0];
    if (!variety) return null;
    const pokemonId = idFromUrl(variety.pokemon.url);
    const p = await getJSON(variety.pokemon.url);

    // The newest English Pokédex entry, and the game it is quoted from.
    let flavor = null;
    let flavorGame = null;
    let flavorRank = -1;
    for (const f of s.flavor_text_entries ?? []) {
      if (f.language.name !== "en") continue;
      const rank = versionRanks[f.version.name];
      if (rank == null || rank <= flavorRank) continue;
      flavorRank = rank;
      flavor = cleanFlavor(f.flavor_text);
      flavorGame = gameName(f.version.name);
    }
    // Gen 4 and earlier shouted every Pokémon and item name. Worth counting so
    // a bake can be eyeballed rather than trusted blindly.
    if (flavor && flavorRank > 0 && flavorRank <= 16) oldBios++;

    if (s.evolution_chain?.url) {
      chainUrls.set(idFromUrl(s.evolution_chain.url), s.evolution_chain.url);
    }

    // Levels come from the newest main-series game that publishes any — the
    // same ranking build-dex.mjs uses to pick the learnset, so the two agree.
    // The "publishes any" part is the safety net: a game that lists a move pool
    // but no levels falls through to the last one that did, which shows a move
    // with no level rather than a made-up one.
    let levelVg = -1;
    for (const mv of p.moves) {
      for (const d of mv.version_group_details) {
        if (d.move_learn_method.name !== "level-up" || !d.level_learned_at) continue;
        const rank = vgRanks[d.version_group.name] ?? -1;
        if (rank > levelVg) levelVg = rank;
      }
    }
    const levelUp = {};
    for (const mv of p.moves) {
      let level = null;
      for (const d of mv.version_group_details) {
        if ((vgRanks[d.version_group.name] ?? -1) !== levelVg) continue;
        if (d.move_learn_method.name !== "level-up") continue;
        if (!d.level_learned_at) continue;
        if (level == null || d.level_learned_at < level) level = d.level_learned_at;
      }
      if (level != null) levelUp[idFromUrl(mv.move.url)] = level;
    }

    // Artwork. Assert the URL we intend to build is the one PokéAPI reports,
    // so a moved path fails the bake instead of the phone.
    const artUrl = p.sprites?.other?.["official-artwork"]?.front_default ?? null;
    if (artUrl && artUrl !== `${ART_BASE}/${pokemonId}.png`) {
      throw new Error(`Artwork URL moved: expected ${ART_BASE}/${pokemonId}.png, got ${artUrl}`);
    }
    if (!artUrl) missingArt++;

    return [
      pokemonId,
      {
        genus: s.genera?.find((g) => g.language.name === "en")?.genus ?? null,
        flavor,
        flavorGame,
        height: p.height, // decimetres
        weight: p.weight, // hectograms
        genderRate: s.gender_rate, // -1 = genderless, else female eighths
        catchRate: s.capture_rate,
        eggGroups: (s.egg_groups ?? []).map((g) => eggGroupName(g.name)),
        hatchCounter: s.hatch_counter,
        growthRate: s.growth_rate ? titleCase(s.growth_rate.name) : null,
        generation: s.generation ? idFromUrl(s.generation.url) : null,
        legendary: s.is_legendary,
        mythical: s.is_mythical,
        baby: s.is_baby,
        chain: s.evolution_chain ? idFromUrl(s.evolution_chain.url) : null,
        levelUp,
        art: artUrl != null,
      },
    ];
  });

  console.log(`Fetching ${chainUrls.size} evolution chains...`);
  const chainRows = await pool([...chainUrls.entries()], CONCURRENCY, async ([id, url]) => {
    const c = await getJSON(url);
    return [id, flattenChain(c.chain)];
  });

  console.log(`  ${oldBios} bios come from Gen 4 or earlier; ${missingArt} have no official artwork.`);

  const species = Object.fromEntries(
    rows.filter(Boolean).sort((a, b) => a[0] - b[0])
  );
  const chains = Object.fromEntries(chainRows.sort((a, b) => a[0] - b[0]));
  return { species, chains };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const [versionRanks, vgRanks] = await Promise.all([
    buildVersionRanks(),
    buildVersionGroupRanks(),
  ]);

  const abilities = await buildAbilities(vgRanks);
  await writeFile(`${OUT}/abilities.json`, JSON.stringify(abilities));
  console.log(`Wrote ${Object.keys(abilities).length} abilities to ${OUT}/abilities.json`);

  const { species, chains } = await buildSpecies(versionRanks, vgRanks);
  await writeFile(`${OUT}/species.json`, JSON.stringify({ species, chains }));
  console.log(
    `Wrote ${Object.keys(species).length} species and ${Object.keys(chains).length} ` +
      `evolution chains to ${OUT}/species.json`
  );

  console.log("\nDone. Commit ./src/data and never call PokéAPI at runtime again.");
}

// Importable for the unit test on cleanFlavor without running the bake.
if (process.argv[1] && process.argv[1].endsWith("build-species.mjs")) {
  main().catch((err) => {
    console.error("Build failed:", err);
    process.exit(1);
  });
}
