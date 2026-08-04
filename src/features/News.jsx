import React from "react";
import { CHANGELOG } from "../data/changelog.js";

/**
 * What's new. Reads top to bottom like a list of updates to a game, because
 * that is what it is — the words live in data/changelog.js.
 */

const KIND_LABEL = { new: "new", fix: "fixed" };
const KIND_COLOUR = { new: "#5FAE55", fix: "var(--amber)" };

/** "2026-08-04" → "4 August 2026", without pulling in a date library. */
export function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${d} ${months[m - 1]} ${y}`;
}

export default function News() {
  return (
    <div>
      <div className="eyebrow">What's new · newest first</div>
      <p className="mono" style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 0 }}>
        Everything that's changed in the lab. If something here doesn't work the
        way you expect, the Report tab is right next door.
      </p>

      {CHANGELOG.map((entry, i) => (
        <div key={`${entry.date}-${i}`} className="news-entry">
          <div className="news-date mono">{prettyDate(entry.date)}</div>
          <h3 className="news-title">{entry.title}</h3>
          {entry.credit && <div className="news-credit mono">★ {entry.credit}</div>}
          {entry.intro && <p className="news-intro">{entry.intro}</p>}
          <ul className="news-list">
            {entry.changes.map((change, j) => (
              <li key={j}>
                <span className="chip news-chip" style={{ background: KIND_COLOUR[change.kind] }}>
                  {KIND_LABEL[change.kind]}
                </span>
                <span>{change.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
