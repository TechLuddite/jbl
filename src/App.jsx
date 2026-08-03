import React, { useState } from "react";
import DamageCalc from "./features/DamageCalc.jsx";
import BattleSim from "./features/BattleSim.jsx";
import League from "./features/League.jsx";
import StatDex from "./features/StatDex.jsx";
import { usingFullDex, POKEDEX } from "./data/index.js";

const TABS = [
  ["calc", "Damage", DamageCalc],
  ["battle", "Battle", BattleSim],
  ["league", "League", League],
  ["dex", "Stats", StatDex],
];

export default function App() {
  const [tab, setTab] = useState("calc");
  const Active = TABS.find(([id]) => id === tab)[2];

  return (
    <div className="wrap">
      <div className="shell">
        <div className="chrome">
          <div className="lens" />
          <div style={{ display: "flex", gap: 5 }}>
            <span className="dot" style={{ background: "#E84B4B" }} />
            <span className="dot" style={{ background: "#E8C24B" }} />
            <span className="dot" style={{ background: "#5FBF63" }} />
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="wordmark">Junior Battle Lab</div>
            <div className="tag">
              {POKEDEX.length} Pokémon · {usingFullDex ? "full dex" : "sample dex"}
            </div>
          </div>
        </div>

        <nav className="tabs">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className="tab"
              data-on={tab === id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <main className="screen">
          <Active />
        </main>
      </div>
    </div>
  );
}
