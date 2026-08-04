import React, { useState, useEffect } from "react";
import DamageCalc from "./features/DamageCalc.jsx";
import BattleSim from "./features/BattleSim.jsx";
import League from "./features/League.jsx";
import StatDex from "./features/StatDex.jsx";
import News from "./features/News.jsx";
import Report from "./features/Report.jsx";
import { usingFullDex, POKEDEX } from "./data/index.js";
import { LATEST } from "./data/changelog.js";
import * as storage from "./lib/storage.js";

/** The lab itself: the four tabs you actually battle with. */
const TABS = [
  ["calc", "Damage", DamageCalc],
  ["battle", "Battle", BattleSim],
  ["league", "League", League],
  ["dex", "Stats", StatDex],
];

/** About the app rather than about Pokémon, so they sit apart, over on the right. */
const META_TABS = [
  ["news", "What's new", News],
  ["report", "Report", Report],
];

const ALL_TABS = [...TABS, ...META_TABS];

export default function App() {
  const [tab, setTab] = useState("calc");
  const Active = ALL_TABS.find(([id]) => id === tab)[2];

  // A dot on the News tab until this build's changes have been looked at.
  // Starts hidden so it can't flash on every load before storage answers.
  const [newsUnread, setNewsUnread] = useState(false);
  useEffect(() => {
    (async () => {
      const seen = await storage.get("news:seen", null);
      setNewsUnread(seen !== LATEST.date);
    })();
  }, []);

  function openTab(id) {
    setTab(id);
    if (id === "news" && newsUnread) {
      setNewsUnread(false);
      storage.set("news:seen", LATEST.date);
    }
  }

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
            <div className="wordmark">Joseph's Battle Lab</div>
            <div className="tag">
              {POKEDEX.length} Pokémon · {usingFullDex ? "full dex" : "sample dex"}
            </div>
          </div>
        </div>

        <nav className="tabs">
          {TABS.map(([id, label]) => (
            <TabButton key={id} id={id} label={label} tab={tab} onOpen={openTab} />
          ))}
          {/* Kept together in their own group so they wrap as a pair, not
              stranded one per line, when the row runs out of room. */}
          <div className="tab-group">
            {META_TABS.map(([id, label]) => (
              <TabButton
                key={id}
                id={id}
                label={label}
                tab={tab}
                onOpen={openTab}
                meta
                dot={id === "news" && newsUnread}
              />
            ))}
          </div>
        </nav>

        <main className="screen">
          <Active />
        </main>
      </div>
    </div>
  );
}

function TabButton({ id, label, tab, onOpen, meta = false, dot = false }) {
  return (
    <button
      className="tab"
      data-on={tab === id}
      data-meta={meta || undefined}
      aria-current={tab === id ? "page" : undefined}
      onClick={() => onOpen(id)}
    >
      {label}
      {dot && <span className="tab-dot" aria-label="new since you last looked" />}
    </button>
  );
}
