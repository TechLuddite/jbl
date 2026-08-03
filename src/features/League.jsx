import React, { useState, useEffect, useMemo } from "react";
import { TYPES } from "../lib/typeChart.js";
import * as storage from "../lib/storage.js";
import { TypeChip } from "../components.jsx";

/**
 * Family league tracker.
 *
 * Data lives in localStorage on one device — see ROADMAP.md before "fixing"
 * that. Export/import is the deliberate stopgap for moving data around.
 */

const DEFAULT_TRAINERS = [
  { id: 1, name: "Champion", role: "Champion", specialty: "dragon" },
  { id: 2, name: "Gym Leader 1", role: "Gym Leader", specialty: "fire" },
  { id: 3, name: "Gym Leader 2", role: "Gym Leader", specialty: "water" },
];

const ROLES = ["Champion", "Elite Four", "Gym Leader", "Challenger"];

export default function League() {
  const [trainers, setTrainers] = useState(DEFAULT_TRAINERS);
  const [battles, setBattles] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("Gym Leader");
  const [newType, setNewType] = useState("normal");

  const [sideA, setSideA] = useState(1);
  const [sideB, setSideB] = useState(2);
  const [winner, setWinner] = useState(1);

  useEffect(() => {
    (async () => {
      setTrainers(await storage.get("league:trainers", DEFAULT_TRAINERS));
      setBattles(await storage.get("league:battles", []));
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) storage.set("league:trainers", trainers); }, [trainers, loaded]);
  useEffect(() => { if (loaded) storage.set("league:battles", battles); }, [battles, loaded]);

  const standings = useMemo(() => {
    const rows = trainers.map((t) => {
      const mine = battles.filter((b) => b.a === t.id || b.b === t.id);
      const wins = mine.filter((b) => b.winner === t.id).length;
      let streak = 0;
      for (let i = mine.length - 1; i >= 0; i--) {
        if (mine[i].winner === t.id) streak++;
        else break;
      }
      return {
        ...t, wins, losses: mine.length - wins, played: mine.length, streak,
        rate: mine.length ? wins / mine.length : 0,
      };
    });
    return rows.sort((x, y) => y.wins - x.wins || y.rate - x.rate || x.losses - y.losses);
  }, [trainers, battles]);

  const nameOf = (id) => trainers.find((t) => t.id === id)?.name ?? "—";

  function addTrainer() {
    const name = newName.trim();
    if (!name) return;
    setTrainers([...trainers, { id: Date.now(), name, role: newRole, specialty: newType }]);
    setNewName("");
  }

  function logBattle() {
    if (sideA === sideB) return;
    setBattles([...battles, {
      id: Date.now(), a: +sideA, b: +sideB, winner: +winner,
      date: new Date().toISOString().slice(0, 10),
    }]);
  }

  async function exportData() {
    const blob = new Blob([JSON.stringify(await storage.exportAll(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jbl-league-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await storage.importAll(data);
      setTrainers(await storage.get("league:trainers", DEFAULT_TRAINERS));
      setBattles(await storage.get("league:battles", []));
    } catch {
      alert("That file isn't a valid league export. Pick a jbl-league-*.json file.");
    }
    event.target.value = "";
  }

  if (!loaded) return <div className="empty">Loading league…</div>;

  return (
    <div>
      <div className="eyebrow">Standings</div>
      <table className="lb" style={{ marginBottom: 22 }}>
        <thead>
          <tr>
            <th>#</th><th>Trainer</th><th>Role</th><th>Type</th>
            <th>W</th><th>L</th><th>Win %</th><th>Streak</th><th />
          </tr>
        </thead>
        <tbody>
          {standings.map((t, i) => (
            <tr key={t.id}>
              <td style={{ color: "var(--ink-soft)" }}>{i + 1}</td>
              <td style={{ fontWeight: 600 }}>{t.name}</td>
              <td style={{ color: "var(--ink-soft)" }}>{t.role}</td>
              <td><TypeChip type={t.specialty} /></td>
              <td>{t.wins}</td>
              <td>{t.losses}</td>
              <td>{t.played ? `${Math.round(t.rate * 100)}%` : "—"}</td>
              <td>{t.streak > 1 ? `W${t.streak} 🔥` : t.streak === 1 ? "W1" : "—"}</td>
              <td style={{ textAlign: "right" }}>
                <button
                  className="btn ghost tiny"
                  onClick={() => {
                    setTrainers(trainers.filter((x) => x.id !== t.id));
                    setBattles(battles.filter((b) => b.a !== t.id && b.b !== t.id));
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        <div className="card">
          <div className="eyebrow">Log a battle</div>
          <div style={{ display: "grid", gap: 8 }}>
            <select className="fld" value={sideA} onChange={(e) => setSideA(+e.target.value)}>
              {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="fld" value={sideB} onChange={(e) => setSideB(+e.target.value)}>
              {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="fld" value={winner} onChange={(e) => setWinner(+e.target.value)}>
              <option value={sideA}>{nameOf(sideA)} won</option>
              <option value={sideB}>{nameOf(sideB)} won</option>
            </select>
            <button className="btn" onClick={logBattle}>Record result</button>
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Add a trainer</div>
          <div style={{ display: "grid", gap: 8 }}>
            <input className="fld" placeholder="Name" value={newName}
                   onChange={(e) => setNewName(e.target.value)} />
            <select className="fld" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
            <select className="fld" value={newType} onChange={(e) => setNewType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="btn ghost" onClick={addTrainer}>Add to league</button>
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Move data between devices</div>
          <div style={{ display: "grid", gap: 8 }}>
            <button className="btn ghost" onClick={exportData}>Export league file</button>
            <label className="btn ghost" style={{ textAlign: "center", cursor: "pointer" }}>
              Import league file
              <input type="file" accept="application/json" onChange={importData} style={{ display: "none" }} />
            </label>
            <div className="empty" style={{ fontSize: 11 }}>
              League data is saved on this device only.
            </div>
          </div>
        </div>
      </div>

      <div className="eyebrow" style={{ marginTop: 22 }}>
        Battle log · {battles.length} recorded
      </div>
      {battles.length === 0 ? (
        <div className="empty">No battles yet. Record one above and the standings fill in.</div>
      ) : (
        <table className="lb">
          <thead><tr><th>Date</th><th>Matchup</th><th>Winner</th><th /></tr></thead>
          <tbody>
            {[...battles].reverse().map((b) => (
              <tr key={b.id}>
                <td style={{ color: "var(--ink-soft)" }}>{b.date}</td>
                <td>{nameOf(b.a)} vs {nameOf(b.b)}</td>
                <td style={{ fontWeight: 600 }}>{nameOf(b.winner)}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost tiny"
                          onClick={() => setBattles(battles.filter((x) => x.id !== b.id))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
