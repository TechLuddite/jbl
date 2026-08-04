import { describe, it, expect } from "vitest";
import {
  buildIssue, issueUrl, issueText, kindById,
  REPORT_KINDS, NEW_ISSUE_URL, MAX_URL_LENGTH,
} from "./feedback.js";

/**
 * Pull one query parameter back out of a built URL. searchParams already
 * decodes, so don't decode again — a body containing "100%" would blow up.
 */
const param = (url, key) => new URL(url).searchParams.get(key) ?? "";

describe("buildIssue", () => {
  it("uses the reporter's own summary as the title", () => {
    const { title } = buildIssue({ kind: "bug", subject: "The Play turn button does nothing" });
    expect(title).toBe("The Play turn button does nothing");
  });

  it("falls back to a sensible title per kind when no summary is given", () => {
    expect(buildIssue({ kind: "idea" }).title).toBe("An idea for the lab");
    expect(buildIssue({ kind: "bug" }).title).toBe("Something's broken");
    expect(buildIssue({ kind: "rule" }).title).toBe("A rule doesn't match the game");
  });

  it("puts the move name in front so the issue list reads at a glance", () => {
    const { title } = buildIssue({ kind: "rule", moveName: "Solar Beam", subject: "fires straight away in rain" });
    expect(title).toBe("Solar Beam — fires straight away in rain");
  });

  it("doesn't repeat the move name when the summary already says it", () => {
    const { title } = buildIssue({ kind: "rule", moveName: "Solar Beam", subject: "Solar Beam skips its charge turn" });
    expect(title).toBe("Solar Beam skips its charge turn");
  });

  it("trims a very long title rather than letting GitHub cut it mid-word", () => {
    const { title } = buildIssue({ subject: "x".repeat(400) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("records the kind, move and app version underneath the details", () => {
    const { body } = buildIssue({
      kind: "rule", moveName: "Outrage", details: "It only lasted one turn.",
      version: "2026-08-04 — Moves that take their time",
    });
    expect(body).toContain("It only lasted one turn.");
    expect(body).toContain("**Kind:** A move or rule is wrong");
    expect(body).toContain("**Move:** Outrage");
    expect(body).toContain("**App version:** 2026-08-04 — Moves that take their time");
  });

  it("leaves out the move and version lines when there aren't any", () => {
    const { body } = buildIssue({ kind: "idea", details: "Add a team builder." });
    expect(body).not.toContain("**Move:**");
    expect(body).not.toContain("**App version:**");
  });

  it("says so plainly when no details were typed", () => {
    expect(buildIssue({ kind: "bug" }).body).toContain("_(No details given.)_");
  });

  it("asks for the label that matches the kind", () => {
    expect(buildIssue({ kind: "bug" }).labels).toBe("bug");
    expect(buildIssue({ kind: "idea" }).labels).toBe("idea");
  });

  it("treats an unknown kind as the first one rather than throwing", () => {
    expect(kindById("nonsense")).toBe(REPORT_KINDS[0]);
    expect(() => buildIssue({ kind: "nonsense" })).not.toThrow();
  });
});

describe("issueUrl", () => {
  it("points at the repo's new-issue page", () => {
    expect(issueUrl(buildIssue({})).startsWith(`${NEW_ISSUE_URL}?`)).toBe(true);
  });

  it("encodes the characters that would otherwise break the link", () => {
    // & would start a new query parameter, # would cut the URL short, and a
    // + would silently become a space on the way out.
    const issue = buildIssue({
      kind: "rule",
      subject: "Fire Spin & Wrap",
      details: "Damage is 1/8 + a bit? See #4 and 100% of max HP.",
    });
    const url = issueUrl(issue);
    expect(param(url, "title")).toBe("Fire Spin & Wrap");
    expect(param(url, "body")).toContain("1/8 + a bit? See #4 and 100% of max HP.");
    // Nothing leaked out of its parameter.
    expect(url.split("#").length).toBe(1);
  });

  it("keeps newlines in the body intact", () => {
    const url = issueUrl(buildIssue({ details: "First line.\nSecond line." }));
    expect(param(url, "body")).toContain("First line.\nSecond line.");
  });

  it("passes the label through", () => {
    expect(param(issueUrl(buildIssue({ kind: "idea" })), "labels")).toBe("idea");
  });

  it("cuts an over-long report down to a link that actually works, and says it did", () => {
    const url = issueUrl(buildIssue({ details: "Solar Beam. ".repeat(2000) }));
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(param(url, "body")).toContain("There was more than would fit");
  });

  it("leaves a normal-length report completely alone", () => {
    const issue = buildIssue({ kind: "rule", moveName: "Yawn", details: "Yawn didn't work on my Gengar." });
    const url = issueUrl(issue);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(param(url, "body")).toBe(issue.body);
  });
});

describe("issueText", () => {
  it("is the title and body, for pasting somewhere else", () => {
    const issue = buildIssue({ kind: "bug", subject: "Stuck", details: "It froze." });
    expect(issueText(issue)).toBe(`Stuck\n\n${issue.body}`);
  });
});
