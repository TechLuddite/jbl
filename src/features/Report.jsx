import React, { useState } from "react";
import { ALL_MOVES } from "../data/index.js";
import { LATEST } from "../data/changelog.js";
import { MoveSelect, Field } from "../components.jsx";
import { REPORT_KINDS, buildIssue, issueUrl, issueText, REPO_URL } from "../lib/feedback.js";

/**
 * Report something.
 *
 * You write the whole thing here; the button then opens GitHub with it already
 * filled in, and you press submit there. There's no server behind this app and
 * there isn't going to be one, so that hand-off is the honest way to do it —
 * and the copy button covers the case where whoever is holding the tablet
 * isn't logged in to GitHub.
 */

const VERSION = `${LATEST.date} — ${LATEST.title}`;

export default function Report() {
  const [kind, setKind] = useState("rule");
  const [moveName, setMoveName] = useState("");
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [copied, setCopied] = useState(false);

  const active = REPORT_KINDS.find((k) => k.id === kind);
  const issue = buildIssue({ kind, subject, moveName, details, version: VERSION });
  const url = issueUrl(issue);
  const ready = subject.trim().length > 0 || details.trim().length > 0;

  async function copyIt() {
    const text = issueText(issue);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked (it needs a secure context and permission). Select
      // the preview instead so it can be copied by hand.
      document.getElementById("report-preview")?.select();
    }
  }

  function reset() {
    setMoveName("");
    setSubject("");
    setDetails("");
    setCopied(false);
  }

  return (
    <div>
      <div className="eyebrow">Report something</div>
      <p className="mono" style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 0 }}>
        Found a move that doesn't work like the real game? Something broken? An
        idea? Write it here and press send — it opens GitHub with your report
        already typed in, and you press submit there.
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="eyebrow">What kind of thing is it?</div>
        <div className="report-kinds">
          {REPORT_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className="btn ghost report-kind"
              data-on={kind === k.id || undefined}
              onClick={() => setKind(k.id)}
            >
              <strong>{k.label}</strong>
              <span className="report-kind-blurb">{k.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ display: "grid", gap: 10 }}>
        {kind === "rule" && (
          <Field label="Which move? (optional)">
            <MoveSelect
              moves={ALL_MOVES}
              allowEmpty
              emptyLabel="— no move in particular —"
              value={moveName}
              onChange={setMoveName}
            />
          </Field>
        )}

        <Field label="Say it in one line">
          <input
            className="fld"
            value={subject}
            placeholder="Solar Beam didn't charge up"
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <Field label="Tell us more">
          <textarea
            className="fld"
            rows={7}
            value={details}
            placeholder={active.placeholder}
            onChange={(e) => setDetails(e.target.value)}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <a
            className="btn"
            href={ready ? url : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!ready}
            data-disabled={!ready || undefined}
            onClick={(e) => { if (!ready) e.preventDefault(); }}
          >
            Send it to GitHub
          </a>
          <button className="btn ghost" onClick={copyIt} disabled={!ready}>
            {copied ? "Copied!" : "Copy it instead"}
          </button>
          {ready && (
            <button className="btn ghost" onClick={reset}>Clear</button>
          )}
        </div>

        <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
          The send button needs a GitHub account — if it asks you to log in, copy
          the report instead and pass it to a grown-up. Nothing about you is
          sent either way: just what you typed, the move you picked and which
          version of the lab you're on.
        </div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className="eyebrow" style={{ cursor: "pointer" }}>
          See exactly what gets sent
        </summary>
        <textarea
          id="report-preview"
          className="fld mono"
          readOnly
          rows={12}
          style={{ marginTop: 8 }}
          value={issueText(issue)}
        />
      </details>

      <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 12 }}>
        Everything reported so far lives at{" "}
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">{REPO_URL.replace("https://", "")}/issues</a>.
      </div>
    </div>
  );
}
