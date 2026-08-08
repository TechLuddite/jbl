import { describe, it, expect } from "vitest";
import {
  POKEDEX, ALL_MOVES, speciesOf, chainOf, artworkFor, abilityInfo, usingSpeciesData,
} from "./index.js";
import { cleanFlavor, condenseRoutes } from "../../scripts/build-species.mjs";

/**
 * `npm run refresh-species` bakes the descriptive layer of the Pokédex — the
 * bios, the sizes, the evolution lines, the ability text. Same guard as the
 * move flags: a bake that half-wrote the file would leave the Pokédex looking
 * plausible and mostly blank, without anything else failing.
 *
 * The bio in particular has to be checked, because it is the one thing on the
 * page presented as fact about a Pokémon rather than a number. It is quoted
 * from a game and it says which game — if either half went missing we would be
 * showing an unattributed sentence, which is exactly what we said we wouldn't.
 */

const dexHas = (name) => POKEDEX.some((p) => p.name === name);
const find = (name) => POKEDEX.find((p) => p.name === name);

describe("cleanFlavor", () => {
  it("unwraps Game Boy line breaks into a sentence", () => {
    expect(cleanFlavor("There is a plant seed on its back right from the\nday this Pokémon is born.")).toBe(
      "There is a plant seed on its back right from the day this Pokémon is born."
    );
  });

  it("rejoins a word split across two lines by a soft hyphen", () => {
    expect(cleanFlavor("It is cov­\nered in fur.")).toBe("It is covered in fur.");
  });

  it("keeps a real hyphen that happened to land at the end of a line", () => {
    expect(cleanFlavor("A well-\nknown sight.")).toBe("A well-known sight.");
  });

  it("turns the page break where the text box paged into a space", () => {
    expect(cleanFlavor("One thing.\fAnother thing.")).toBe("One thing. Another thing.");
  });

  it("stops the older games shouting POKéMON", () => {
    expect(cleanFlavor("This POKéMON is rare.")).toBe("This Pokémon is rare.");
  });

  it("leaves an already-clean sentence exactly as it is", () => {
    const line = "While it is young, it uses the nutrients that are stored in the seed on its back in order to grow.";
    expect(cleanFlavor(line)).toBe(line);
  });
});

describe("condenseRoutes", () => {
  it("collapses the same trick told once per game", () => {
    expect(condenseRoutes([
      "Level up at Mt Coronet", "Level up at Chargestone Cave",
      "Level up at New Mauville", "Use a Thunder Stone",
    ])).toEqual(["Level up somewhere special", "Use a Thunder Stone"]);
  });

  it("leaves a single named place alone — that one is worth knowing", () => {
    expect(condenseRoutes(["Level up at Mount Lanakila"])).toEqual(["Level up at Mount Lanakila"]);
  });

  it("doesn't touch routes that aren't places", () => {
    const routes = ["Level 16", "Use a Water Stone"];
    expect(condenseRoutes(routes)).toEqual(routes);
  });
});

// The rest only mean anything with the file baked. On a fresh clone that hasn't
// run refresh-species there is nothing to guard, and saying so is better than
// a wall of failures about missing data.
describe.runIf(usingSpeciesData)("baked species data", () => {
  it("covers every Pokémon in the dex", () => {
    const missing = POKEDEX.filter((p) => !speciesOf(p));
    expect(missing.map((p) => p.name)).toEqual([]);
  });

  it("gives every Pokémon a bio and names the game it is quoted from", () => {
    for (const p of POKEDEX) {
      const s = speciesOf(p);
      expect(s.flavor?.length, `${p.name} has no bio`).toBeGreaterThan(0);
      expect(s.flavorGame?.length, `${p.name}'s bio doesn't say which game`).toBeGreaterThan(0);
    }
  });

  it("leaves no Game Boy line breaks in a bio", () => {
    for (const p of POKEDEX) {
      const { flavor } = speciesOf(p);
      expect(flavor, `${p.name}'s bio still has raw formatting`).not.toMatch(/[\n\r\f­]/);
      expect(flavor).not.toMatch(/POK[Ééé]MON/);
      expect(flavor.trim()).toBe(flavor);
    }
  });

  it("quotes the bios it is asked about, verbatim", () => {
    // Spot checks against the published entries. These are quotations, so they
    // are exact — if a bake changes one, it changed which game it quoted.
    if (dexHas("Bulbasaur")) {
      expect(speciesOf(find("Bulbasaur")).flavor).toBe(
        "While it is young, it uses the nutrients that are stored in the seed on its back in order to grow."
      );
    }
    if (dexHas("Bulbasaur")) expect(speciesOf(find("Bulbasaur")).genus).toBe("Seed Pokémon");
    if (dexHas("Charizard")) expect(speciesOf(find("Charizard")).genus).toBe("Flame Pokémon");
    if (dexHas("Pikachu")) expect(speciesOf(find("Pikachu")).genus).toBe("Mouse Pokémon");
  });

  it("has the sizes the games publish", () => {
    // Heights are decimetres and weights hectograms, straight from PokéAPI.
    if (dexHas("Bulbasaur")) {
      expect(speciesOf(find("Bulbasaur")).height).toBe(7); // 0.7 m
      expect(speciesOf(find("Bulbasaur")).weight).toBe(69); // 6.9 kg
    }
    if (dexHas("Wailord")) expect(speciesOf(find("Wailord")).height).toBe(145); // 14.5 m
  });

  it("knows which Pokémon have no gender", () => {
    if (dexHas("Magnemite")) expect(speciesOf(find("Magnemite")).genderRate).toBe(-1);
    if (dexHas("Nidoran F")) expect(speciesOf(find("Nidoran F")).genderRate).toBe(8);
    if (dexHas("Bulbasaur")) expect(speciesOf(find("Bulbasaur")).genderRate).toBe(1);
  });

  it("gets the famous evolution lines right", () => {
    if (dexHas("Charmeleon")) {
      const chain = chainOf(find("Charmeleon"));
      expect(chain.map((s) => s.name)).toEqual(["Charmander", "Charmeleon", "Charizard"]);
      expect(chain[1].how).toEqual(["Level 16"]);
      expect(chain[2].how).toEqual(["Level 36"]);
    }
    if (dexHas("Eevee")) {
      // Eevee branches. Every branch has to be there, or the line lies.
      const names = chainOf(find("Eevee")).map((s) => s.name);
      expect(names[0]).toBe("Eevee");
      expect(names).toContain("Vaporeon");
      expect(names).toContain("Sylveon");
    }
  });

  it("writes every evolution condition as a readable sentence", () => {
    const routes = [...new Set(
      POKEDEX.flatMap((p) => chainOf(p).flatMap((stage) => stage.how ?? []))
    )];
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      // "Use Move" and friends: a trigger that fell through to its own slug.
      expect(route, "an evolution trigger has no wording of its own").not.toMatch(/^(Use|Take) Move$/);
      // "a Ice Stone".
      expect(route, `bad article in "${route}"`).not.toMatch(/\ba [AEIOUaeiou]/);
      // A route longer than this is a list of places pretending to be a
      // sentence — condenseRoutes exists to stop that.
      expect(route.length, `"${route}" is too long to read in a row`).toBeLessThan(70);
    }
  });

  it("gives every level it lists to a move that exists", () => {
    const moveIds = new Set(ALL_MOVES.map((m) => m.id));
    for (const p of POKEDEX) {
      for (const id of Object.keys(speciesOf(p).levelUp)) {
        expect(moveIds.has(Number(id)), `${p.name} learns unknown move ${id}`).toBe(true);
      }
    }
  });

  it("has level-up moves for the Pokémon that learn any", () => {
    // Ditto, Metapod and friends genuinely learn one thing, so this is a
    // coverage check, not a per-Pokémon rule. A bake that lost the levels
    // entirely would sail past every check above but not this one.
    const withLevels = POKEDEX.filter((p) => Object.keys(speciesOf(p).levelUp).length > 0);
    expect(withLevels.length).toBeGreaterThan(POKEDEX.length * 0.95);
  });

  it("takes the level-up moves from the same game as the learnset", () => {
    // Both are baked from the newest main-series game a Pokémon appears in, so
    // a move with a level should almost always be in the learnset next to it.
    // A mismatch here means the two bakes have drifted onto different games.
    if (dexHas("Bulbasaur")) {
      const bulbasaur = find("Bulbasaur");
      const learnset = new Set(bulbasaur.learnset);
      const levels = Object.keys(speciesOf(bulbasaur).levelUp).map(Number);
      expect(levels.length).toBeGreaterThan(0);
      expect(levels.every((id) => learnset.has(id))).toBe(true);
    }
  });

  it("has not left Gen 1 stranded on its Red and Blue learnset", () => {
    // PokéAPI's Japan-only Gen 1 re-releases carry ids above Scarlet/Violet.
    // Ranked on id they win "latest game", and Mewtwo comes out knowing Barrier
    // and nothing since. scripts/version-groups.mjs is what stops that.
    if (dexHas("Mewtwo")) {
      expect(find("Mewtwo").learnset.length).toBeGreaterThan(60);
    }
    if (dexHas("Bulbasaur")) {
      const names = new Set(find("Bulbasaur").learnset.map((id) =>
        ALL_MOVES.find((m) => m.id === id)?.name));
      expect(names.has("Bide")).toBe(false); // Gen 1 only
      expect(names.has("Seed Bomb")).toBe(true); // Gen 4 onwards
    }
  });

  it("has a big picture for every Pokémon", () => {
    for (const p of POKEDEX) {
      expect(artworkFor(p), `${p.name} has no picture`).toMatch(/^https:\/\//);
    }
    if (dexHas("Charizard")) {
      expect(artworkFor(find("Charizard"))).toBe(
        "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/6.png"
      );
    }
  });

  it("knows the real name and description of every ability the dex uses", () => {
    const nameless = [];
    const wordless = [];
    for (const p of POKEDEX) {
      for (const { slug } of p.abilities ?? []) {
        const info = abilityInfo(slug);
        if (!info.name) nameless.push(slug);
        if (!info.desc) wordless.push(slug);
      }
    }
    expect(nameless).toEqual([]);
    expect([...new Set(wordless)]).toEqual([]);
  });

  it("spells the awkward ability names the way the games do", () => {
    expect(abilityInfo("solar-power").name).toBe("Solar Power");
    expect(abilityInfo("soul-heart").name).toBe("Soul-Heart");
    expect(abilityInfo("as-one-glastrier").name).toContain("As One");
  });
});
