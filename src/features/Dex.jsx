import React, { useState, useEffect, useMemo } from "react";
import {
  POKEDEX, legalMoves, speciesOf, chainOf, artworkFor, abilityInfo,
  usingSpeciesData,
} from "../data/index.js";
import { TYPE_COLOR } from "../lib/typeChart.js";
import { ABILITIES } from "../lib/sim.js";
import {
  defensiveMatchups, multLabel, formatHeight, formatWeight, genderLabel,
  catchLabel, evolutionSteps, splitLearnset,
} from "../lib/dex.js";
import { TypeChip, Field, StatBar, PokemonSelect } from "../components.jsx";

/**
 * The Pokédex: everything known about one Pokémon, on one screen.
 *
 * The other tabs all answer a question you brought with you — how hard does
 * this hit, who won. This one is for browsing, so it leads with the picture and
 * the bio and puts the numbers underneath.
 *
 * The bio is quoted from the games and says which game it came from. Nothing
 * on this page is written by us about a Pokémon; it is either the game's own
 * words or a number out of the dex.
 */

const STAT_LABELS = {
  hp: "HP", atk: "Attack", def: "Defense",
  spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed",
};

/** #6 → "#0006", the way the dex has numbered them since Gen 8. */
const dexNumber = (id) => `#${String(id).padStart(4, "0")}`;

export default function Dex({ focus = null }) {
  const [id, setId] = useState(POKEDEX[0].id);
  const [moveView, setMoveView] = useState("level");
  const [moveQuery, setMoveQuery] = useState("");

  // Arriving from the link button on the Stats tab. `focus` carries a counter
  // as well as an id, so pressing the same link twice still lands here.
  useEffect(() => {
    if (focus?.id != null && POKEDEX.some((p) => p.id === focus.id)) setId(focus.id);
  }, [focus]);

  const index = POKEDEX.findIndex((p) => p.id === id);
  const pokemon = POKEDEX[index] ?? POKEDEX[0];
  const species = speciesOf(pokemon);

  const step = (by) => {
    const next = POKEDEX[(index + by + POKEDEX.length) % POKEDEX.length];
    if (next) setId(next.id);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="Pokémon">
          <PokemonSelect list={POKEDEX} value={id} onChange={setId} />
        </Field>
        <button className="btn ghost" onClick={() => step(-1)} aria-label="Previous Pokémon">◀</button>
        <button className="btn ghost" onClick={() => step(1)} aria-label="Next Pokémon">▶</button>
      </div>

      <Hero pokemon={pokemon} species={species} />
      {species && <Vitals species={species} />}
      <Abilities pokemon={pokemon} />
      <BaseStats pokemon={pokemon} />
      <Matchups pokemon={pokemon} />
      <Evolution pokemon={pokemon} onPick={setId} />
      <Moves
        pokemon={pokemon}
        species={species}
        view={moveView}
        onView={setMoveView}
        query={moveQuery}
        onQuery={setMoveQuery}
      />

      {!usingSpeciesData && (
        <p className="empty" style={{ marginTop: 18 }}>
          The bios, sizes and evolution lines come from a data file that hasn't
          been built in this copy. Run <span className="mono">npm run refresh-species</span> to add them.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ hero -- */

function Hero({ pokemon, species }) {
  const art = artworkFor(pokemon);
  return (
    <div className="dex-hero">
      <div className="dex-art-frame">
        {art
          ? <img className="dex-art" src={art} alt={pokemon.name} width="240" height="240" />
          : <span className="empty">no picture</span>}
      </div>

      <div className="dex-headline">
        <div className="dex-id mono">{dexNumber(pokemon.id)}</div>
        <h2 className="dex-name">{pokemon.name}</h2>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "6px 0" }}>
          {pokemon.types.map((t) => <TypeChip key={t} type={t} />)}
        </div>
        {species?.genus && <div className="dex-genus mono">{species.genus}</div>}
        {species?.flavor && (
          <>
            <p className="dex-bio">{species.flavor}</p>
            {species.flavorGame && (
              <div className="dex-bio-source mono">
                From the Pokédex in Pokémon {species.flavorGame}
              </div>
            )}
          </>
        )}
        {(species?.legendary || species?.mythical || species?.baby) && (
          <div className="dex-rare mono">
            {species.mythical ? "★ Mythical" : species.legendary ? "★ Legendary" : "★ Baby"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- vitals -- */

function Vitals({ species }) {
  const rows = [
    ["Height", formatHeight(species.height)],
    ["Weight", formatWeight(species.weight)],
    ["Gender", genderLabel(species.genderRate)],
    ["Catch rate", catchLabel(species.catchRate)],
    ["Egg groups", species.eggGroups?.length ? species.eggGroups.join(", ") : null],
    ["Egg cycles", species.hatchCounter ? `${species.hatchCounter} to hatch` : null],
    ["Growth", species.growthRate],
    ["First seen in", species.generation ? `Generation ${species.generation}` : null],
  ].filter(([, value]) => value);

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>Vital statistics</div>
      <div className="dex-vitals">
        {rows.map(([label, value]) => (
          <div key={label} className="dex-vital">
            <div className="eyebrow" style={{ marginBottom: 2 }}>{label}</div>
            <div className="mono dex-vital-value">{value}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- abilities -- */

function Abilities({ pokemon }) {
  const abilities = pokemon.abilities ?? [];
  if (!abilities.length) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>Abilities</div>
      <div className="dex-abilities">
        {abilities.map(({ slug, hidden }) => {
          const info = abilityInfo(slug);
          return (
            <div key={slug} className="dex-ability">
              <div className="dex-ability-name mono">
                {info.name}
                {hidden && <span className="dex-tag">hidden</span>}
                {/* The sim only offers abilities it actually models, so say
                    which ones those are rather than letting a Pokémon look
                    broken when its ability does nothing in a battle. */}
                {!ABILITIES[slug] && <span className="dex-tag quiet">not in the sim yet</span>}
              </div>
              {info.desc && <div className="dex-ability-desc">{info.desc}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ base stats -- */

function BaseStats({ pokemon }) {
  const colour = TYPE_COLOR[pokemon.types[0]];
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>
        Base stats · total {pokemon.bst}
      </div>
      <div className="card">
        {Object.entries(STAT_LABELS).map(([key, label]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
            <span className="mono" style={{ fontSize: 11, width: 58, color: "var(--ink-soft)" }}>{label}</span>
            <span className="mono" style={{ fontSize: 12, width: 30, fontWeight: 600 }}>{pokemon.stats[key]}</span>
            <StatBar value={pokemon.stats[key]} max={255} color={colour} />
          </div>
        ))}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- matchups -- */

function Matchups({ pokemon }) {
  const buckets = useMemo(() => defensiveMatchups(pokemon.types), [pokemon]);
  const groups = [
    ["Takes more from", buckets.weak],
    ["Shrugs off", buckets.resist],
    ["Can't be touched by", buckets.immune],
  ].filter(([, list]) => list.length);

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>
        When it's defending
      </div>
      <div className="card">
        {groups.map(([label, list]) => (
          <div key={label} className="dex-matchup-row">
            <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {list.map(({ type, mult }) => (
                <span key={type} className="dex-matchup">
                  <TypeChip type={type} />
                  <span className="mono dex-mult">{multLabel(mult)}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="empty" style={{ marginTop: 8 }}>
          Types only. An ability like Levitate or Thick Fat changes these in a
          real battle, and the Battle tab does apply it.
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- evolution -- */

function Evolution({ pokemon, onPick }) {
  const chain = chainOf(pokemon);
  const steps = evolutionSteps(chain);
  if (!steps.length) {
    return chain.length ? (
      <>
        <div className="eyebrow" style={{ marginTop: 18 }}>Evolution</div>
        <div className="empty">{pokemon.name} doesn't evolve.</div>
      </>
    ) : null;
  }

  const known = (id) => POKEDEX.some((p) => p.id === id);

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>Evolution</div>
      <div className="card">
        {steps.map((s, i) => (
          <div key={i} className="dex-evo">
            <EvoStage stage={s.from} current={pokemon.id} onPick={known(s.from.id) ? onPick : null} />
            <span className="dex-evo-how mono">{s.how || "evolves"} →</span>
            <EvoStage stage={s.to} current={pokemon.id} onPick={known(s.to.id) ? onPick : null} />
          </div>
        ))}
      </div>
    </>
  );
}

function EvoStage({ stage, current, onPick }) {
  const isCurrent = stage.id === current;
  if (!onPick) return <span className="dex-evo-stage" data-on={isCurrent || undefined}>{stage.name}</span>;
  return (
    <button
      className="dex-evo-stage"
      data-on={isCurrent || undefined}
      onClick={() => onPick(stage.id)}
    >
      {stage.name}
    </button>
  );
}

/* ----------------------------------------------------------------- moves -- */

function Moves({ pokemon, species, view, onView, query, onQuery }) {
  const { byLevel, other } = useMemo(() => {
    const moves = legalMoves(pokemon);
    // legalMoves falls back to every move in the game for the sample dex,
    // which is honest for the sim but nonsense on a Pokédex page — so only
    // treat it as a learnset when there really is one.
    const learnset = pokemon.learnset?.length ? moves : [];
    return splitLearnset(learnset, species?.levelUp ?? {});
  }, [pokemon, species]);

  const rows = view === "level" ? byLevel : [...byLevel, ...other]
    .sort((a, b) => a.move.name.localeCompare(b.move.name));

  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter(({ move }) => move.name.toLowerCase().includes(q) || move.type.includes(q))
    : rows;

  if (!pokemon.learnset?.length) {
    return (
      <>
        <div className="eyebrow" style={{ marginTop: 18 }}>Moves</div>
        <div className="empty">
          Move lists come with the full dex. This copy is running on the sample set.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 18 }}>Moves</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn ghost tiny" data-on={view === "level" || undefined}
                  onClick={() => onView("level")}>
            As it levels up
          </button>
          <button className="btn ghost tiny" data-on={view === "all" || undefined}
                  onClick={() => onView("all")}>
            Everything it can learn
          </button>
        </div>
        <input className="fld" style={{ width: 180, marginLeft: "auto" }} type="search"
               placeholder="find a move" value={query} onChange={(e) => onQuery(e.target.value)} />
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {view === "level" && !byLevel.length
            ? `The dex doesn't list levels for ${pokemon.name} — try "Everything it can learn".`
            : `No moves match “${query}”.`}
        </div>
      ) : (
        // Seven columns don't fit a phone, so the table scrolls sideways inside
        // its own box rather than pushing the whole page over.
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          <table className="lb" style={{ minWidth: 460 }}>
            <thead>
              <tr>
                <th style={{ width: 42 }}>Lv</th>
                <th>Move</th><th>Type</th><th>Kind</th>
                <th style={{ width: 42 }}>Pwr</th>
                <th style={{ width: 42 }}>Acc</th>
                <th style={{ width: 36 }}>PP</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ move, level }) => (
                <tr key={move.id}>
                  <td className="mono" style={{ color: "var(--ink-soft)" }}>{level ?? "—"}</td>
                  <td style={{ fontWeight: 600 }}>{move.name}</td>
                  <td><TypeChip type={move.type} /></td>
                  <td style={{ color: "var(--ink-soft)" }}>{move.category}</td>
                  <td>{move.power ?? "—"}</td>
                  <td>{move.accuracy ?? "—"}</td>
                  <td>{move.pp ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="empty" style={{ marginTop: 6 }}>
        {shown.length} of {byLevel.length + other.length} moves ·
        {" "}from the newest game {pokemon.name} appears in
      </div>
    </>
  );
}
