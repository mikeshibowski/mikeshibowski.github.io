// Where each task stands. An arrow a -> b means a is a sub-task of b.
//   blocked - an open task still points into it, so it can't be done yet
//             (how many doesn't matter: one is enough)
//   goal    - tasks point into it and it points to no other task: the top
//             of its tree
// The renderer shows doable tasks with a bright centre, blocked ones soft,
// and goals with a small peak above.
export function taskStates(items, edges) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const isTask = (id) => byId.get(id)?.kind === "task";
  const fed = new Set(); // has a task pointing into it
  const blocked = new Set(); // has an open task pointing into it
  const feeds = new Set(); // points to a task
  for (const e of edges) {
    if (!isTask(e.a) || !isTask(e.b)) continue;
    fed.add(e.b);
    feeds.add(e.a);
    if (!byId.get(e.a).done) blocked.add(e.b);
  }
  const out = new Map();
  for (const i of items) {
    if (i.kind !== "task") continue;
    out.set(i.id, { blocked: !i.done && blocked.has(i.id), goal: fed.has(i.id) && !feeds.has(i.id) });
  }
  return out;
}

// The line a task stands on: everything it leads up to, through to its
// goals, and everything under it. Siblings and other branches stay out.
// Thoughts, questions and artifacts linked to anything on the line (or to
// each other from there) belong to it too. A selected one stands on the
// lines of the tasks it's linked to; with none, on its own little group.
export function taskLine(items, edges, id) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const isTask = (k) => byId.get(k)?.kind === "task";
  const up = new Map();
  const down = new Map();
  const near = new Map(); // any arrow, either way
  const add = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  for (const e of edges) {
    add(near, e.a, e.b);
    add(near, e.b, e.a);
    if (!isTask(e.a) || !isTask(e.b)) continue;
    add(up, e.a, e.b);
    add(down, e.b, e.a);
  }
  // Out from `from` through non-tasks only; tasks met on the way are noted.
  const notes = (from, line, met = new Set()) => {
    const todo = [...from];
    while (todo.length) {
      for (const k of near.get(todo.pop()) ?? []) {
        if (line.has(k)) continue;
        if (isTask(k)) met.add(k);
        else {
          line.add(k);
          todo.push(k);
        }
      }
    }
    return met;
  };
  const line = new Set([id]);
  const tasks = isTask(id) ? [id] : [...notes([id], line)];
  for (const t of tasks) {
    line.add(t);
    for (const next of [up, down]) {
      const todo = [t];
      while (todo.length) {
        for (const k of next.get(todo.pop()) ?? []) {
          if (!line.has(k)) {
            line.add(k);
            todo.push(k);
          }
        }
      }
    }
  }
  notes([...line], line);
  return line;
}
