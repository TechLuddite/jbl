/**
 * Which game a learnset should come from.
 *
 * Shared by build-dex.mjs and build-species.mjs so the move list and the levels
 * next to it always come from the same game. If they drift apart, the Pokédex
 * shows a move at "Level 24" that the Pokémon can't actually learn.
 *
 * The rule is "the newest game each Pokémon appears in", and the whole reason
 * this file exists is that PokéAPI's version-group ids are a bad way to spell
 * "newest":
 *
 *   - The Japan-only Gen 1 re-releases were added to the API years late, so
 *     they carry ids ABOVE Scarlet/Violet while holding 1996 data. Ranked on id
 *     they win for most of Gen 1, and Mewtwo comes out knowing Barrier, Bide
 *     and nothing since.
 *   - The Legends games and the battle-only spin-offs rebuilt moves from
 *     scratch. In Legends: Arceus a Zubat knows seven moves and there are no
 *     TMs at all — true of that game, and useless as "what Zubat can learn".
 *
 * So the ranking runs over the main-series games only: the ones with a full
 * move pool, moves learned at levels, and TMs. Everything else is listed below
 * with the reason it is out. That list is deliberate — a new main-series game
 * needs nothing doing, but a new spin-off needs a line here, or half the dex
 * quietly forgets how to battle.
 */

export const NOT_MAIN_SERIES = new Map([
  ["colosseum", "GameCube side game — a shadow Pokémon's few starting moves"],
  ["xd", "GameCube side game — same"],
  ["lets-go-pikachu-lets-go-eevee", "Let's Go dropped most moves and all breeding"],
  ["legends-arceus", "Legends rebuilt the move system; ~7 moves each, no TMs"],
  ["legends-za", "same family as Legends: Arceus"],
  ["mega-dimension", "Legends: Z-A's expansion"],
  ["champions", "battle-only, and nothing in it is learned at a level"],
  ["red-green-japan", "1996 re-release, added to the API with a modern id"],
  ["blue-japan", "1996 re-release, added to the API with a modern id"],
]);

/**
 * PokéAPI's `/version-group` index → { name: rank }, main-series only. Within
 * that set the ids ARE chronological, so the id doubles as the rank.
 */
export function rankVersionGroups(results) {
  const ranks = {};
  for (const vg of results) {
    if (NOT_MAIN_SERIES.has(vg.name)) continue;
    ranks[vg.name] = Number(vg.url.replace(/\/$/, "").split("/").pop());
  }
  return ranks;
}
