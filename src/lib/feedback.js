/**
 * Turning an in-app report into a GitHub issue.
 *
 * There is no backend and there never will be one (see CLAUDE.md — no
 * accounts, nothing collecting personal data). So the report is composed
 * in the app, and the "send" button opens GitHub's new-issue page with the
 * title and body already filled in. The reporter presses submit there.
 *
 * That means two things this module has to get right:
 *   - Everything is URL-encoded properly. A report about "Fire Spin & Wrap"
 *     or a move with a # in it must not break the link.
 *   - The link has to stay short enough to survive a browser. Browsers cap
 *     URL length, and a long report would silently truncate mid-word or fail
 *     outright, so long bodies are cut here, deliberately and visibly.
 */

export const REPO = "TechLuddite/jbl";
export const REPO_URL = `https://github.com/${REPO}`;
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/**
 * Browsers vary, but every current one handles well past this. Kept well
 * under the lowest common limit so there is room for the encoding to expand.
 */
export const MAX_URL_LENGTH = 6000;

/** Titles longer than this get trimmed — GitHub shows them truncated anyway. */
const MAX_TITLE = 120;

const CUT_NOTE = "\n\n_(There was more than would fit in the link — ask me and I'll tell you the rest.)_";

/**
 * What kind of report this is. `label` is what the reporter sees, `issueLabel`
 * is the GitHub label asked for (GitHub ignores it unless the sender has
 * permission to set labels, which is fine — it's a hint, not a requirement).
 */
export const REPORT_KINDS = [
  {
    id: "rule",
    label: "A move or rule is wrong",
    blurb: "The sim did something the real game wouldn't do.",
    issueLabel: "rules",
    placeholder:
      "What did you do, what happened, and what should have happened?\n\n" +
      "Example: I used Solar Beam in the rain and it fired straight away. " +
      "In the game it should charge for a turn first.",
    fallbackTitle: "A rule doesn't match the game",
  },
  {
    id: "bug",
    label: "Something's broken",
    blurb: "A button doesn't work, or the app got stuck or looks wrong.",
    issueLabel: "bug",
    placeholder:
      "What were you doing when it went wrong?\n\n" +
      "Example: I pressed Play turn on the Battle tab and nothing happened.",
    fallbackTitle: "Something's broken",
  },
  {
    id: "idea",
    label: "I've got an idea",
    blurb: "Something you'd like the lab to be able to do.",
    issueLabel: "idea",
    placeholder:
      "What would you like it to do?\n\n" +
      "Example: I'd like to save a team of six and see all its weaknesses at once.",
    fallbackTitle: "An idea for the lab",
  },
];

export const kindById = (id) => REPORT_KINDS.find((k) => k.id === id) ?? REPORT_KINDS[0];

/**
 * Compose the issue. `subject` is the reporter's one-line summary, `details`
 * the long text, `moveName` the optional move it's about, and `version` the
 * app stamp so we know which build they were on.
 */
export function buildIssue({ kind = "rule", subject = "", moveName = "", details = "", version = "" } = {}) {
  const k = kindById(kind);
  const trimmedSubject = subject.trim();
  const move = moveName.trim();

  // A move name up front makes the issue list readable at a glance.
  let title = trimmedSubject || k.fallbackTitle;
  if (move && !trimmedSubject.toLowerCase().includes(move.toLowerCase())) {
    title = `${move} — ${title}`;
  }
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;

  const body = [
    details.trim() || "_(No details given.)_",
    "",
    "---",
    `**Kind:** ${k.label}`,
    move ? `**Move:** ${move}` : null,
    version ? `**App version:** ${version}` : null,
    "",
    "_Sent from the Report tab in Joseph's Battle Lab._",
  ].filter((line) => line !== null).join("\n");

  return { title, body, labels: k.issueLabel };
}

/**
 * The GitHub new-issue link for an issue from buildIssue. If the body is too
 * long to survive as a URL it is cut short and says so, rather than being
 * quietly mangled by the browser.
 */
export function issueUrl({ title = "", body = "", labels = "" } = {}) {
  const build = (b) =>
    `${NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}` +
    (labels ? `&labels=${encodeURIComponent(labels)}` : "");

  if (build(body).length <= MAX_URL_LENGTH) return build(body);

  // Shave the body down until the whole link fits, note and all.
  let text = body;
  while (text.length > 0 && build(text + CUT_NOTE).length > MAX_URL_LENGTH) {
    text = text.slice(0, Math.floor(text.length * 0.85));
  }
  return build(text + CUT_NOTE);
}

/** The plain-text version, for the copy-it-instead button. */
export function issueText({ title = "", body = "" } = {}) {
  return `${title}\n\n${body}`;
}
