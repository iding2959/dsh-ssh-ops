// Terminal output → readable text: the log viewer and the agent-facing log
// tools must not print escape-sequence debris, while the stored log keeps its
// raw bytes. The fixtures below are real sequences seen in recorded sessions
// (shell-integration markers from a real server, an OSC 7 cwd report, an
// OSC 1337 command, colour codes and bracketed-paste toggles).
import assert from "node:assert/strict";
import { readableLine, toReadableText, toReadableTextAsync } from "../src/terminal-text.js";

const ESC = "\u001b";

// ── the debris a real session logs ─────────────────────────────────────────
{
  const raw = [
    "Last login: Fri Sep 18 23:58:06 2026 from 111.180.64.27",
    // BEL-terminated shell-integration markers, exactly as the real server emits them
    `${ESC}]133;C\u0007${ESC}]133;C\u0007${ESC}]133;D;0\u0007${ESC}]1337;Command=c3R0eSAtZWNobw==\u0007${ESC}]7;file://host/root\u0007${ESC}]133;A\u0007`,
    `${ESC}]3008;start=836f28a4;user=root;hostname=iZ2vc;pid=00000000000000148399;type=shell;cwd=/root\u0007${ESC}[?2004h${ESC}]0;root@iZ2vc: ~\u0007`,
    `root@iZ2vc:~# \r${ESC}[K\r${ESC}]0;root@iZ2vc: ~\u0007root@iZ2vc:~# ${ESC}]133;B\u0007`
  ].join("\n");
  const readable = toReadableText(raw);
  assert.match(readable, /Last login: Fri Sep 18 23:58:06 2026 from 111\.180\.64\.27/);
  assert.equal(readable.split("\n").filter((line) => line.startsWith("root@iZ2vc:~#")).length, 1,
    "the redrawn prompt appears once, its markers never do");
  for (const debris of ["]133;", "]1337;", "]3008;", "]7;file:", "?2004h", "[K", ESC]) {
    assert.equal(readable.includes(debris), false, `stripped: ${debris}`);
  }
}

// ── colours, and carriage returns that OVERWRITE (terminal line semantics) ──
{
  const raw = `${ESC}[31merror${ESC}[0m: disk ${ESC}[1mfull${ESC}[0m\n`;
  assert.equal(toReadableText(raw), "error: disk full");

  const progress = "copying 10%\rcopying 50%\rcopying 100%\n";
  assert.equal(toReadableText(progress), "copying 100%", "a progress bar shows its final state, not every frame");

  assert.equal(toReadableText(`first line\r${ESC}[Kreplaced\n`), "replaced", "erase-in-line clears the redraw");
  assert.equal(toReadableText("long content here\rshort"), "shortcontent here",
    "a shorter redraw leaves the tail it never overwrote (no erase was sent)");
}

// ── ST-terminated OSC and split-ish leftovers ──────────────────────────────
{
  assert.equal(toReadableText(`before${ESC}]0;title${ESC}\\after`), "beforeafter");
  assert.equal(toReadableText(`x${ESC}(B y`), "x y", "charset selection is dropped, its text kept");
  assert.equal(toReadableText("plain\tkeeps\ttabs\nand newlines"), "plain   keeps   tabs\nand newlines",
    "tabs advance to the next 8-column stop, as a terminal does");
  assert.equal(toReadableText("nul\u0000byte and \u0007bell"), "nulbyte and bell");
}

// ── the exact prompt-redraw cycle a real bash logs ──────────────────────────
{
  const redraw = "load average: 0.05, 0.10, 0.09\r\n" + Array.from({ length: 12 }, () =>
    `root@iZ2vc27mmzgpr2oszj1kplZ:~# \r${ESC}[K\r${ESC}]0;root@iZ2vc27mmzgpr2oszj1kplZ: ~\u0007root@iZ2vc27mmzgpr2oszj1kplZ:~# ${ESC}]133;B\u0007`
  ).join("");
  assert.deepEqual(toReadableText(redraw).split("\n"), [
    "load average: 0.05, 0.10, 0.09",
    "root@iZ2vc27mmzgpr2oszj1kplZ:~#"
  ], "twelve redraws collapse into one prompt line");
}

// ── readableLine trims only the tail ───────────────────────────────────────
{
  assert.equal(readableLine(`  ${ESC}[32mok${ESC}[0m  `), "  ok", "leading spaces (prompt indentation) stay");
  assert.equal(readableLine(""), "");
  assert.equal(readableLine(null), "");
}

// ── the async (non-blocking) entry renders exactly the same text ───────────
// `toReadableTextAsync` exists so a large recording does not hold the event
// loop; it is a second copy of the same state machine, so the two must agree
// byte for byte or the panel and the agent would see different logs.
{
  const fixtures = [
    `${ESC}[32mok${ESC}[0m done\r\n`,
    // A bare CR rewinds the row: chunking the input cannot preserve this, which
    // is why the async path keeps one pass and only yields control.
    "aaa\r\nbbb\rccc\r\nddd",
    "progress 10%\rprogress 55%\rprogress 100%\n",
    `${ESC}[1;31mred${ESC}[0m\ttab\r\n`,
    `emoji ${ESC}]0;title\u0007 中文\r\n`,
    `${ESC}[2Kpartial${ESC}[3Gcol\r\n`
  ];
  for (const fixture of fixtures) {
    assert.equal(await toReadableTextAsync(fixture, 1), toReadableText(fixture), `async agrees on ${JSON.stringify(fixture.slice(0, 24))}`);
    assert.equal(await toReadableTextAsync(fixture, 1_000_000), toReadableText(fixture), "yield cadence does not change the result");
  }
  // A payload past the yield threshold must still match exactly.
  const big = `${ESC}[32mline${ESC}[0m\r\n`.repeat(20_000);
  assert.equal(await toReadableTextAsync(big, 65536), toReadableText(big));
}

console.log("terminal text: escape debris stripped, prompts and content preserved");
