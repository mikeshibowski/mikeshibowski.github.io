// Quick-capture syntax:
//   "t ..." or "[] ..."       -> task
//   "? ..." or "...?"         -> question
//   plain text                -> thought
//   "a: ..."                  -> artifact
//   Tab in the input steps the kind on through KINDS
//   "!1".."!4"                -> importance, 1 highest
//   "@" or "@ name"           -> wormhole to a new canvas (the name is optional)

// A new item starts as a thought; Tab then offers the kinds most used first.
export const KINDS = ["thought", "task", "question", "artifact"];

export function parseCapture(text, cycle = 0) {
  let kind = "thought";
  let title = text.trimStart();
  if (title.startsWith("@")) {
    return { kind: "wormhole", title: title.slice(1).replace(/\s+/g, " ").trim(), importance: 4 };
  }
  const prefix = title.match(/^(\[\]\s*|t\s+)/i);
  const artifact = title.match(/^a:\s*/i);
  const question = title.match(/^\?\s*/);
  if (prefix) {
    kind = "task";
    title = title.slice(prefix[0].length);
  } else if (artifact) {
    kind = "artifact";
    title = title.slice(artifact[0].length);
  } else if (question) {
    kind = "question";
    title = title.slice(question[0].length);
  } else if (/\?\s*$/.test(title)) {
    kind = "question"; // the "?" stays: it's part of the question
  }
  kind = KINDS[(KINDS.indexOf(kind) + cycle) % KINDS.length];
  let importance = 4;
  title = title.replace(/(^|\s)!([1-4])(?=\s|$)/, (_, pre, n) => {
    importance = Number(n);
    return pre;
  });
  return { kind, title: title.replace(/\s+/g, " ").trim(), importance };
}

// A list, one item per line (the ≡ box). No syntax here: a line's text is
// its title, and its kind is picked with Tab on that line (kinds[i], by
// line number). A line not set yet is a thought, or a question if it ends
// in "?". A leading bullet ("- ", "* ", "• ", "1. ", "1) ") is dropped, so
// pasted lists work.
export const listLine = (raw) => raw.trim().replace(/^([-*•]|\d+[.)])(\s+|$)/, "").replace(/\s+/g, " ");

export const lineKind = (raw, kind = null) => kind ?? (/\?\s*$/.test(raw) ? "question" : "thought");

export function parseList(text, kinds = []) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const title = listLine(raw);
    if (title) out.push({ kind: lineKind(raw, kinds[i]), title, importance: 4 });
  });
  return out;
}

// After an edit, each line keeps the kind it had: the lines before and
// after the edited stretch are matched up, and the edited stretch keeps
// its kinds line by line (a new line starts unset).
export function followKinds(before, after, kinds) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const out = kinds.slice(0, head);
  const was = before.length - head - tail;
  for (let i = 0; i < after.length - head - tail; i++) out.push(i < was ? kinds[head + i] ?? null : null);
  for (let i = before.length - tail; i < before.length; i++) out.push(kinds[i] ?? null);
  return out;
}
