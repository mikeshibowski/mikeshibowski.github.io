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

// A list, one item per line (the ≡ box): each line in the syntax above.
// A leading bullet ("- ", "* ", "• ", "1. ", "1) ") is dropped, so pasted
// lists work; "[]" is left alone, it means task.
export function parseList(text, cycle = 0) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^([-*•]|\d+[.)])(\s+|$)/, "");
    if (!line) continue;
    const entry = parseCapture(line, cycle);
    if (entry.title || entry.kind === "wormhole") out.push(entry);
  }
  return out;
}
