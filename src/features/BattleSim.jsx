import React, { useState, useEffect } from "react";
import { POKEDEX, legalMoves } from "../data/index.js";
import { ITEMS } from "../lib/sim.js";
import { TypeChip, Field, PokemonSelect, MoveSelect, ItemSelect, AbilitySelect } from "../components.jsx";
import * as storage from "../lib/storage.js";
import BattleRunner, { newSlot, dexOf, abilityOptions } from "./BattleRunner.jsx";

/**
 * The battle sim tab: u-pick two teams of 1-6, then play it out turn by turn.
 * Either side can be handed to the sim ("auto"), so the same screen covers
 * hotseat play and watch-it-play-out mode. The battle screen itself lives in
 * BattleRunner.jsx, shared with the league tourney.
 *
 * Move legality comes from legalMoves(): real learnsets once the full dex is
 * baked, anything-goes on the sample set.
 */

const SIDE_NAMES = ["Red team", "Blue team"];

export default function BattleSim() {
  const [phase, setPhase] = useState("pick"); // pick | fight
  const [teams, setTeams] = useState([[newSlot(6)], [newSlot(9)]]);
  const [auto, setAuto] = useState([false, false]);
  const [runKey, setRunKey] = useState(0);
  const [winner, setWinner] = useState(null);

  // League tie-in: offered after the battle, never automatic on this tab.
  const [trainers, setTrainers] = useState([]);
  const [trainerPick, setTrainerPick] = useState([0, 0]);
  const [recorded, setRecorded] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await storage.get("league:trainers", []);
      setTrainers(t);
      if (t.length >= 2) setTrainerPick([t[0].id, t[1].id]);
    })();
  }, [phase]);

  function updateSlot(side, i, patch) {
    setTeams((prev) => prev.map((team, s) => {
      if (s !== side) return team;
      return team.map((slot, j) => {
        if (j !== i) return slot;
        // Re-picking the Pokémon resets its moves to the new default four.
        if (patch.pokemonId != null && patch.pokemonId !== slot.pokemonId) {
          return newSlot(patch.pokemonId);
        }
        return { ...slot, ...patch };
      });
    }));
  }

  function startBattle() {
    setWinner(null);
    setRecorded(false);
    setRunKey((k) => k + 1);
    setPhase("fight");
  }

  async function recordInLeague() {
    const [ta, tb] = trainerPick;
    if (winner == null || ta === tb) return;
    const battles = await storage.get("league:battles", []);
    battles.push({
      id: Date.now(), a: +ta, b: +tb,
      winner: winner === 0 ? +ta : +tb,
      date: new Date().toISOString().slice(0, 10),
      sim: true,
    });
    await storage.set("league:battles", battles);
    setRecorded(true);
  }

  if (phase === "pick") {
    return (
      <div>
        <div className="eyebrow">Pick two teams · 1 to 6 Pokémon each</div>
        <div className="duel">
          {[0, 1].map((side) => (
            <div key={side} className="card">
              <div className="eyebrow">{SIDE_NAMES[side]}</div>
              {teams[side].map((slot, i) => (
                <TeamSlot
                  key={i}
                  slot={slot}
                  onChange={(patch) => updateSlot(side, i, patch)}
                  onRemove={teams[side].length > 1
                    ? () => setTeams((prev) => prev.map((t, s) => (s === side ? t.filter((_, j) => j !== i) : t)))
                    : null}
                />
              ))}
              {teams[side].length < 6 && (
                <button
                  className="btn ghost"
                  style={{ width: "100%" }}
                  onClick={() => setTeams((prev) => prev.map((t, s) => (s === side ? [...t, newSlot(POKEDEX[(t.length * 7) % POKEDEX.length].id)] : t)))}
                >
                  Add a Pokémon
                </button>
              )}
              <label className="mono" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={auto[side]}
                  onChange={(e) => setAuto((prev) => prev.map((v, s) => (s === side ? e.target.checked : v)))}
                />
                Let the sim play this side
              </label>
            </div>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={startBattle}>
          Start the battle
        </button>
      </div>
    );
  }

  return (
    <BattleRunner
      key={runKey}
      slots={teams}
      auto={auto}
      sideNames={SIDE_NAMES}
      onWinner={setWinner}
      onExit={() => setPhase("pick")}
      exitLabel="Back to team picks"
      overContent={({ restart }) => (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => { setWinner(null); setRecorded(false); restart(); }}>
              Rematch
            </button>
            <button className="btn ghost" onClick={() => setPhase("pick")}>New teams</button>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="eyebrow">Record this in the league?</div>
            {trainers.length < 2 ? (
              <div className="empty">Add at least two trainers on the League tab first.</div>
            ) : recorded ? (
              <div className="mono" style={{ fontSize: 12 }}>Recorded. Check the League tab.</div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {[0, 1].map((side) => (
                  <Field key={side} label={`${SIDE_NAMES[side]} was`}>
                    <select
                      className="fld"
                      value={trainerPick[side]}
                      onChange={(e) => setTrainerPick((prev) => prev.map((v, s) => (s === side ? +e.target.value : v)))}
                    >
                      {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </Field>
                ))}
                <button
                  className="btn"
                  disabled={trainerPick[0] === trainerPick[1]}
                  onClick={recordInLeague}
                  style={{ alignSelf: "end" }}
                >
                  Record result
                </button>
              </div>
            )}
          </div>
        </>
      )}
    />
  );
}

/* ------------------------------------------------------- subcomponents --- */

function TeamSlot({ slot, onChange, onRemove }) {
  const p = dexOf(slot);
  const legal = legalMoves(p);

  return (
    <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 8, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <PokemonSelect list={POKEDEX} style={{ flex: 1 }} value={slot.pokemonId}
                       onChange={(id) => onChange({ pokemonId: id })} />
        <input className="fld" style={{ width: 64 }} type="number" min="1" max="100"
               title="Level" value={slot.level}
               onChange={(e) => onChange({ level: Math.min(100, Math.max(1, +e.target.value || 1)) })} />
        {onRemove && <button className="btn ghost tiny" onClick={onRemove}>✕</button>}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
        {p.types.map((t) => <TypeChip key={t} type={t} />)}
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-soft)" }}>
          {legal.length} moves to pick from
        </span>
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr", marginBottom: 6 }}>
        <ItemSelect items={ITEMS} value={slot.item} onChange={(item) => onChange({ item })} />
        <AbilitySelect options={abilityOptions(p)} value={slot.ability}
                       onChange={(ability) => onChange({ ability })} />
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
        {[0, 1, 2, 3].map((i) => (
          <MoveSelect
            key={i}
            moves={legal}
            allowEmpty
            value={slot.moveNames[i] ?? ""}
            onChange={(name) => {
              const names = [...slot.moveNames];
              names[i] = name;
              onChange({ moveNames: names.filter(Boolean) });
            }}
          />
        ))}
      </div>
    </div>
  );
}
