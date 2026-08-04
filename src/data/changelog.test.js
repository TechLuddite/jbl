import { describe, it, expect } from "vitest";
import { CHANGELOG, LATEST } from "./changelog.js";

/**
 * The changelog is hand-written prose, so there is nothing to check about the
 * words. What IS worth guarding is the shape: the top entry doubles as the
 * app's version stamp on every bug report, so an entry added out of order or
 * missing a date would quietly mislabel every report that follows.
 */

describe("changelog", () => {
  it("has entries", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });

  it("gives every entry a date, a title and at least one change", () => {
    for (const entry of CHANGELOG) {
      expect(entry.date, `entry "${entry.title}" needs a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title?.length, "every entry needs a title").toBeGreaterThan(0);
      expect(entry.changes?.length, `entry "${entry.title}" needs changes`).toBeGreaterThan(0);
    }
  });

  it("only uses the two kinds the UI knows how to draw", () => {
    for (const entry of CHANGELOG) {
      for (const change of entry.changes) {
        expect(["new", "fix"]).toContain(change.kind);
        expect(change.text?.length).toBeGreaterThan(0);
      }
    }
  });

  it("is newest first, so LATEST really is the latest", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(LATEST).toBe(CHANGELOG[0]);
  });
});
