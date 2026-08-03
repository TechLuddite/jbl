import React, { useState, useEffect, useRef } from "react";
import { POKEDEX } from "../data/index.js";
import { createBracket, reportWinner, pendingMatches, championOf } from "../lib/tourney.js";
import * as storage from "../lib/storage.js";
import { PokemonSelect } from "../components.jsx";
import BattleRunner, { newSlot, simBattleWinner } from "./BattleRunner.jsx";

/**
 * League battles. Every trainer fights with their single league Pokémon at
 * level 50 with its best four moves — same rules for everyone, so the only
 * choice that matters is which Pokémon you pick.
 *
 * Secret picks: choices made in the pass-the-device round are stored on the
 * battle or tourney itself, never written back to the trainer's public pick,
 * so the standings table can't leak them. In a secret tourney the bracket
 * shows ??? until a Pokémon has battled.
 */

export default function LeagueBattles({ trainers, onSetPokemon, logResult }) {
  const [tourney, setTourney] = useState(null);
  const [loaded, setLoaded] = useState(false);

  // One-off match form
  const [qa, setQa] = useState(0);
  const [qb, setQb] = useState(0);
  const [qSecret, setQSecret] = useState(false);

  // Tourney setup form
  const [entrants, setEntrants] = useState([]);
  const [tSecret, setTSecret] = useState(false);

  const [secretFlow, setSecretFlow] = useState(null); // { queue, onDone }
  const [match, setMatch] = useState(null);           // the battle being played

  useEffect(() => {
    (async () => {
      setTourney(await storage.get("league:tourney", null));
      setLoaded(true);
    })();
  }, []);
  useEffect(() => { if (loaded) storage.set("league:tourney", tourney); }, [tourney, loaded]);

  // Keep the forms pointing at trainers that still exist.
  useEffect(() => {
    if (trainers.length >= 2) {
      setQa((v) => (trainers.some((t) => t.id === v) ? v : trainers[0].id));
      setQb((v) => (trainers.some((t) => t.id === v) ? v : trainers[1].id));
    }
    setEntrants((prev) => {
      const valid = prev.filter((id) => trainers.some((t) => t.id === id));
      return valid.length ? valid : trainers.map((t) => t.id);
    });
  }, [trainers]);

  const trainerOf = (id) => trainers.find((t) => t.id === id);
  const nameOf = (id) => trainerOf(id)?.name ?? "—";
  const publicPick = (id) => trainerOf(id)?.pokemonId ?? null;
  const pokeName = (pid) => POKEDEX.find((p) => p.id === pid)?.name ?? "—";

  const slotFor = (id, picks) => {
    const pid = picks?.[id] ?? publicPick(id);
    return pid ? [newSlot(pid)] : null;
  };

  /* ------------------------------------------------------- one-off match --- */

  const canQuick = trainers.length >= 2 && qa !== qb &&
    (qSecret || (publicPick(qa) && publicPick(qb)));

  function startQuick(mode) {
    const begin = (picks) => setMatch({
      aId: qa, bId: qb, picks,
      auto: mode === "auto" ? [true, true] : [false, false],
      instant: mode === "auto",
      tourneyRef: null,
      runKey: Date.now(),
    });
    if (qSecret) setSecretFlow({ queue: [qa, qb], onDone: begin });
    else begin({});
  }

  /* ------------------------------------------------------------- tourney --- */

  const entrantsReady = tSecret || entrants.every((id) => publicPick(id));
  const canStart = entrants.length >= 2 && entrantsReady;

  function startTourney() {
    const shuffled = entrants.filter((id) => trainerOf(id));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const create = (picks) => setTourney({
      bracket: createBracket(shuffled),
      secret: tSecret, picks, revealed: [],
      started: new Date().toISOString().slice(0, 10),
    });
    if (tSecret) setSecretFlow({ queue: shuffled, onDone: create });
    else create({});
  }

  function startTourneyMatch(m, mode) {
    setMatch({
      aId: m.a, bId: m.b, picks: tourney.picks ?? {},
      auto: mode === "auto" ? [true, true] : [false, false],
      instant: mode === "auto",
      tourneyRef: { round: m.round, index: m.index },
      runKey: Date.now(),
    });
  }

  function finishMatch(m, winnerSide) {
    const winnerId = winnerSide === 0 ? m.aId : m.bId;
    logResult(m.aId, m.bId, winnerId, m.tourneyRef ? { tourney: true } : {});
    if (m.tourneyRef) {
      setTourney((t) => t && ({
        ...t,
        bracket: reportWinner(t.bracket, m.tourneyRef.round, m.tourneyRef.index, winnerId),
        revealed: [...new Set([...(t.revealed ?? []), m.aId, m.bId])],
      }));
    }
  }

  /** Sim every remaining match in one go — no UI, results straight to the log. */
  function simRest() {
    let t = tourney;
    let guard = 0;
    while (t && guard++ < 200) {
      const pend = pendingMatches(t.bracket)
        .filter((m) => slotFor(m.a, t.picks) && slotFor(m.b, t.picks));
      if (!pend.length) break;
      const m = pend[0];
      const side = simBattleWinner(slotFor(m.a, t.picks), slotFor(m.b, t.picks), Date.now() + guard);
      const winnerId = side === 0 ? m.a : m.b;
      logResult(m.a, m.b, winnerId, { tourney: true });
      t = {
        ...t,
        bracket: reportWinner(t.bracket, m.round, m.index, winnerId),
        revealed: [...new Set([...(t.revealed ?? []), m.a, m.b])],
      };
    }
    setTourney(t);
  }

  /* -------------------------------------------------------------- render --- */

  if (!loaded) return null;

  if (match) {
    const slotsA = slotFor(match.aId, match.picks);
    const slotsB = slotFor(match.bId, match.picks);
    if (!slotsA || !slotsB) { setMatch(null); return null; }
    return (
      <div style={{ marginTop: 22 }}>
        <div className="eyebrow">
          League battle · {nameOf(match.aId)} vs {nameOf(match.bId)}
          {match.tourneyRef ? " · tourney" : ""}
        </div>
        <BattleRunner
          key={match.runKey}
          slots={[slotsA, slotsB]}
          auto={match.auto}
          instant={match.instant}
          sideNames={[nameOf(match.aId), nameOf(match.bId)]}
          onWinner={(side) => finishMatch(match, side)}
          onExit={() => setMatch(null)}
          exitLabel="Quit this battle"
          overContent={() => (
            <div style={{ marginTop: 10 }}>
              <div className="mono" style={{ fontSize: 12, marginBottom: 8 }}>
                Result saved to the league.
              </div>
              <button className="btn" onClick={() => setMatch(null)}>
                {match.tourneyRef ? "Back to the bracket" : "Back to the league"}
              </button>
            </div>
          )}
        />
      </div>
    );
  }

  const champion = tourney ? championOf(tourney.bracket) : null;
  const pokeLabel = (id) => {
    const pid = tourney?.picks?.[id] ?? publicPick(id);
    if (!pid) return "—";
    if (tourney?.secret && !(tourney.revealed ?? []).includes(id)) return "???";
    return pokeName(pid);
  };

  return (
    <div style={{ marginTop: 22 }}>
      <div className="eyebrow">League battles · played in the sim</div>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginBottom: 14 }}>
        <div className="card">
          <div className="eyebrow">League Pokémon · level 50, best four moves</div>
          {trainers.length === 0 ? (
            <div className="empty">Add trainers first.</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {trainers.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 12, width: 92, flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.name}
                  </span>
                  <PokemonSelect
                    list={POKEDEX}
                    style={{ flex: 1 }}
                    value={t.pokemonId ?? null}
                    onChange={(id) => onSetPokemon(t.id, id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="eyebrow">Battle it out</div>
          {trainers.length < 2 ? (
            <div className="empty">You need at least two trainers.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <select className="fld" value={qa} onChange={(e) => setQa(+e.target.value)}>
                {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select className="fld" value={qb} onChange={(e) => setQb(+e.target.value)}>
                {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <label className="mono" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={qSecret} onChange={(e) => setQSecret(e.target.checked)} />
                Secret picks first — pass the device round
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" disabled={!canQuick} onClick={() => startQuick("manual")}>
                  Play it out
                </button>
                <button className="btn ghost" disabled={!canQuick} onClick={() => startQuick("auto")}>
                  Let the sim play it
                </button>
              </div>
              {!canQuick && qa !== qb && !qSecret && (
                <div className="empty" style={{ fontSize: 11 }}>
                  Both trainers need a league Pokémon set (or tick secret picks).
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="eyebrow">Knockout tourney</div>
        {!tourney ? (
          trainers.length < 2 ? (
            <div className="empty">You need at least two trainers.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                Tick who's in. Pairings are drawn at random, then it's win or go home.
              </div>
              <div style={{ display: "grid", gap: 4, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                {trainers.map((t) => (
                  <label key={t.id} className="mono" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={entrants.includes(t.id)}
                      onChange={(e) => setEntrants((prev) =>
                        e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id))}
                    />
                    {t.name}
                    <span style={{ color: "var(--ink-soft)" }}>
                      {publicPick(t.id) ? `· ${pokeName(publicPick(t.id))}` : "· no Pokémon yet"}
                    </span>
                  </label>
                ))}
              </div>
              <label className="mono" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={tSecret} onChange={(e) => setTSecret(e.target.checked)} />
                Secret picks first — pass the device round
              </label>
              <div>
                <button className="btn" disabled={!canStart} onClick={startTourney}>Start the tourney</button>
              </div>
              {!canStart && entrants.length >= 2 && (
                <div className="empty" style={{ fontSize: 11 }}>
                  Everyone ticked needs a league Pokémon (or tick secret picks).
                </div>
              )}
            </div>
          )
        ) : (
          <>
            {champion != null && (
              <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
                🏆 {nameOf(champion)} is the champion!
              </div>
            )}
            <div className="bracket">
              {tourney.bracket.rounds.map((round, r) => (
                <div key={r} className="bracket-round">
                  <div className="eyebrow">{roundName(r, tourney.bracket.rounds.length)}</div>
                  {round.map((m, i) => (
                    <MatchBox
                      key={i}
                      m={m}
                      nameOf={nameOf}
                      pokeLabel={pokeLabel}
                      playable={m.winner === undefined && m.a != null && m.b != null &&
                        slotFor(m.a, tourney.picks) && slotFor(m.b, tourney.picks)}
                      onPlay={() => startTourneyMatch({ ...m, round: r, index: i }, "manual")}
                      onSim={() => startTourneyMatch({ ...m, round: r, index: i }, "auto")}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {champion == null && pendingMatches(tourney.bracket).length > 0 && (
                <button className="btn ghost" onClick={simRest}>Sim the rest of the tourney</button>
              )}
              <button
                className="btn ghost"
                onClick={() => {
                  if (window.confirm(champion != null
                    ? "Clear the finished tourney?"
                    : "Scrap this tourney? Played matches stay in the battle log.")) {
                    setTourney(null);
                  }
                }}
              >
                {champion != null ? "Clear the tourney" : "Scrap this tourney"}
              </button>
            </div>
          </>
        )}
      </div>

      {secretFlow && (
        <SecretPicks
          trainers={trainers}
          queue={secretFlow.queue}
          onCancel={() => setSecretFlow(null)}
          onDone={(picks) => { setSecretFlow(null); secretFlow.onDone(picks); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------- subcomponents --- */

function roundName(r, total) {
  const fromEnd = total - 1 - r;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-finals";
  if (fromEnd === 2) return "Quarter-finals";
  return `Round ${r + 1}`;
}

function MatchBox({ m, nameOf, pokeLabel, playable, onPlay, onSim }) {
  const decided = m.winner !== undefined;
  const line = (id) => (
    <div
      className="bracket-name"
      style={{
        fontWeight: decided && m.winner === id && id != null ? 700 : 400,
        color: decided && m.winner !== id ? "var(--ink-soft)" : "inherit",
      }}
    >
      <span>{id === null ? "bye" : id === undefined ? "…" : nameOf(id)}</span>
      <span style={{ color: "var(--ink-soft)" }}>{id != null ? pokeLabel(id) : ""}</span>
    </div>
  );
  return (
    <div className="bracket-match">
      {line(m.a)}
      {line(m.b)}
      {playable && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button className="btn tiny" onClick={onPlay}>Play</button>
          <button className="btn ghost tiny" onClick={onSim}>Sim</button>
        </div>
      )}
    </div>
  );
}

/**
 * The pass-the-device secret pick round. Full-screen so nothing underneath
 * (standings, the bracket) can give a pick away while the device goes round.
 */
function SecretPicks({ trainers, queue, onDone, onCancel }) {
  const [i, setI] = useState(0);
  const [stage, setStage] = useState("handoff"); // handoff | pick
  const [pickId, setPickId] = useState(null);
  const picksRef = useRef({});

  const t = trainers.find((x) => x.id === queue[i]);
  if (!t) return null;

  const shownPick = pickId ?? t.pokemonId ?? POKEDEX[0].id;

  function lockIn() {
    picksRef.current[t.id] = shownPick;
    if (i + 1 < queue.length) {
      setI(i + 1);
      setStage("handoff");
      setPickId(null);
    } else {
      onDone({ ...picksRef.current });
    }
  }

  return (
    <div className="mask-overlay">
      <div className="mask-panel">
        {stage === "handoff" ? (
          <>
            <div className="eyebrow">Secret picks · {i + 1} of {queue.length}</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
              Pass the device to {t.name}
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 14 }}>
              No peeking, everyone else.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setStage("pick")}>
                I'm {t.name} — let me pick
              </button>
              <button className="btn ghost" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="eyebrow">{t.name} picks in secret</div>
            <PokemonSelect list={POKEDEX} value={shownPick} onChange={setPickId} />
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", margin: "8px 0 12px" }}>
              Level 50, best four moves — same rules for everyone.
            </div>
            <button className="btn" onClick={lockIn}>Lock it in and hand it back</button>
          </>
        )}
      </div>
    </div>
  );
}
