import { COLORS, HIGHLIGHT_RULES } from "./rules.js";

/**
 * Longest slice of a logical line the BUILT-IN rules are allowed to see.
 *
 * Even with every quantifier bounded, a line built entirely of quotes and
 * backslashes makes each candidate start position re-scan to the end of the
 * line, so the total stays proportional to the line length. A terminal row
 * cannot display anywhere near this many cells, and the built-in rules are
 * decoration, so cutting the tail off a pathological line costs nothing the
 * user can see — it converts "cost grows with whatever `cat` printed" into a
 * fixed ceiling.
 *
 * Custom user rules are exempt: their author chose the pattern, and silently
 * matching only a prefix would change what their rule means. They stay guarded
 * by the worker's own timeout, which reports the failure instead of hiding it.
 */
const MATCH_MAX_CHARS = 4096;

// Compiled per-rule regexes, keyed by the rule's own pattern object.
//
// `matchText` runs once per logical line per rule, so a 50-row viewport
// compiled 50 × 25 = 1250 regexes on every scan. `compileScheme` rebuilds the
// rule objects for each new scheme, so the cache is keyed on the pattern
// object rather than the rule: a new scheme produces new keys, and the old
// entries are collected with the scheme. Measured saving is small (0.7us per
// compile, ~1ms per 50-row scan) but it is free and removes a per-frame
// allocation burst.
const compiledPatterns = new WeakMap();

function globalRegexFor(pattern) {
  let compiled = compiledPatterns.get(pattern);
  if (compiled === undefined) {
    // Strip `g`/`y` and re-add `g`: the caller relies on all matches in order,
    // and a sticky regex would anchor every match at lastIndex.
    compiled = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
    compiledPatterns.set(pattern, compiled);
  }
  // Shared instance: `matchAll` clones it internally, but a caller throwing
  // mid-iteration leaves lastIndex non-zero on some engines — reset first so a
  // later line cannot start mid-string.
  compiled.lastIndex = 0;
  return compiled;
}

// Tokenize a logical line. Reserve whole tokens before the cell-style filter,
// so ANSI-styled fragments cannot make a lower-priority rule leak through.
export function matchText(text, rules = HIGHLIGHT_RULES, colors = COLORS, limit = 4096) {
  // Only the built-in set gets the length ceiling (see MATCH_MAX_CHARS).
  const bounded = rules === HIGHLIGHT_RULES && text.length > MATCH_MAX_CHARS;
  const source = bounded ? text.slice(0, MATCH_MAX_CHARS) : text;
  const occupied = new Uint8Array(source.length), spans = [];
  const add = (start, end, color) => {
    if (spans.length >= limit) return;
    if (!color) return;
    if (end <= start) return; // zero-width matches (e.g. an option's empty value) decorate nothing
    if (occupied.subarray(start, end).some(Boolean)) return;
    occupied.fill(1, start, end); spans.push({ start, end, color });
  };
  // Context-only rules: don't mistake arbitrary output words for commands.
  const prompt = /^(?![-+])[^\n]*?(?:[$#>]|(?<!\d)%)[ \t]+/.exec(source);
  const context = prompt ? prompt[0].length : -1;
  for (const rule of rules) {
    if (spans.length >= limit) break;
    if ((rule.id === "context" || (rule.id === "mac" && rule.context !== false)) && context >= 0) {
      const enabled = (key) => !Array.isArray(rule.context) || rule.context.includes(key);
      for (const command of enabled("command") ? source.slice(context).matchAll(/(?:^|[|])\s*([\w.-]+)(?=\s|$)/g) : []) {
        const start = context + command.index + command[0].lastIndexOf(command[1]);
        add(start, start + command[1].length, colors.command);
      }
      const sign = prompt[0].search(/[$#%>]/);
      if (enabled("prompt")) add(sign, sign + 1, colors.prompt);
      for (const m of enabled("string") ? source.slice(context).matchAll(/(?:~?\/|[\w.-]+\/)[^\s"'|;<>]*/g) : []) add(context + m.index, context + m.index + m[0].length, colors.string);
    }
    // Per-rule context gate: rules flagged context:true (command/prompt/path/
    // flag detection) must not fire on plain output lines.
    if (rule.context === true && context < 0) continue;
    if (!rule.pattern) continue;
    for (const m of source.matchAll(globalRegexFor(rule.pattern))) {
      if (spans.length >= limit) break;
      if (!m[0].length || (rule.accept && !rule.accept(m[0]))) continue;
      if (rule.option && m[0].includes("=")) {
        const split = m.index + m[0].indexOf("=");
        add(m.index, split, colors.option);
        add(split, split + 1, colors.heading);
        add(split + 1, m.index + m[0].length, colors.info);
      } else if (rule.permissions) {
        if (occupied.subarray(m.index, m.index + m[0].length).some(Boolean)) continue;
        for (let i = 0; i < m[0].length; i++) {
          const c = m[0][i];
          // Type char (d/l/s/b/c/p/-) is the debug bucket; r/w/exec/acl map by char.
          add(m.index + i, m.index + i + 1, i === 0 ? colors.debug : c === "r" ? colors.info : c === "w" ? colors.warning : /[xsStT]/.test(c) ? colors.error : colors.heading);
        }
      } else add(m.index, m.index + m[0].length, colors[rule.color]);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// xterm 5.5 cells describe both Unicode widths and original ANSI attributes.
// Automatic wraps are joined; hard newlines remain separate logical lines.
export function readLogicalLine(buffer, start, maxCells = 16384) {
  let text = "", y = start, cells = 0;
  const positions = [];
  // One scratch cell per read: xterm's getCell(x) allocates a CellData on
  // every call unless a reusable cell is supplied, which is the bulk of this
  // function's allocation on a 200-row scan.
  const scratch = typeof buffer.getNullCell === "function" ? buffer.getNullCell() : undefined;
  const cellAt = (line, x) => (scratch ? line.getCell(x, scratch) : line.getCell(x));
  do {
    const line = buffer.getLine(y);
    if (!line) break;
    const nextLine = buffer.getLine(y + 1);
    const last = cellAt(line, line.length - 1);
    // xterm inserts an empty padding cell when a wide glyph cannot fit at
    // the right edge. It is not a space in the original logical text.
    const padded = nextLine?.isWrapped && last?.getCode() === 0 && last.getWidth() === 1 && cellAt(nextLine, 0)?.getWidth() === 2;
    const length = line.length - (padded ? 1 : 0);
    for (let x = 0; x < length && cells < maxCells; x++, cells++) {
      const cell = cellAt(line, x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      const position = { x, y, width: cell.getWidth(), eligible: cell.isAttributeDefault() };
      for (let i = 0; i < chars.length; i++) positions.push(position);
      text += chars;
    }
    y++;
  } while (cells < maxCells && buffer.getLine(y)?.isWrapped);
  return { text, positions, next: y };
}

export function matchLogicalLine(logical, viewportStart, viewportEnd, limit = 4096, colors = COLORS, rules = HIGHLIGHT_RULES) {
  return spansToRuns(logical, matchText(logical.text, rules, colors, limit), viewportStart, viewportEnd, limit);
}
export function spansToRuns(logical, spans, viewportStart, viewportEnd, limit = 4096) {
  const runs = [];
  for (const span of spans) {
    let run;
    let previous;
    for (let i = span.start; i < span.end; i++) {
      const p = logical.positions[i];
      if (p === previous) continue; // emoji surrogate halves / combined glyph
      previous = p;
      if (!p?.eligible || p.y < viewportStart || p.y >= viewportEnd) { run = undefined; continue; }
      if (run && run.y === p.y && run.x + run.width === p.x) run.width += p.width;
      else {
        if (runs.length >= limit) return runs;
        run = { x: p.x, y: p.y, width: p.width, foregroundColor: span.color };
        runs.push(run);
      }
    }
  }
  return runs;
}
