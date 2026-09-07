const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(require("node:path").join(__dirname, "../site/atlas.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("function timedContent("), source.indexOf("function setPrimaryLyric(")), context);

test("last lyric with explicit pause keeps karaoke and finishes before trailing silence", () => {
  const item = {
    duration_seconds: 224.747833,
    timed_content: {
      text: "Blijf bij me\n",
      markers: [
        { offset: 0, time_ms: 205564 },
        { offset: 5, time_ms: 206306 },
        { offset: 6, time_ms: 206890 },
        { offset: 13, time_ms: 207792 },
        { offset: 13, time_ms: 224749 },
      ],
      pauses: [5, 13],
    },
  };
  const [line] = context.lyricLines(item);
  assert.equal(line.karaoke, true);
  const beginning = context.karaokeState(line, 205900);
  assert.ok(beginning.progress > 0 && beginning.progress < 1);
  assert.equal(beginning.after, " bij me");
  const ending = context.karaokeState(line, 207300);
  assert.ok(ending.progress > 0 && ending.progress < 1);
  assert.equal(context.karaokeState(line, 207792).before, "Blijf bij me");
});

test("internal markers around whitespace also enable karaoke", () => {
  const [line] = context.lyricLines({ duration_seconds: 10, timed_content: {
    text: "Blijf bij me", markers: [
      { offset: 0, time_ms: 1000 }, { offset: 5, time_ms: 2000 },
      { offset: 6, time_ms: 3000 }, { offset: 12, time_ms: 4000 },
    ],
  } });
  assert.equal(line.karaoke, true);
});

test("a whole-line unit uses line highlighting", () => {
  const [line] = context.lyricLines({ duration_seconds: 10, timed_content: {
    text: "Blijf bij me", markers: [
      { offset: 0, time_ms: 1000 }, { offset: 12, time_ms: 4000 },
    ],
  } });
  assert.equal(line.karaoke, false);
});

test("pauses at the beginning and end do not split a whole-line unit", () => {
  const [line] = context.lyricLines({ duration_seconds: 10, timed_content: {
    text: "Blijf bij me", pauses: [0, 12], markers: [
      { offset: 0, time_ms: 1000 }, { offset: 0, time_ms: 2000 },
      { offset: 12, time_ms: 4000 }, { offset: 12, time_ms: 6000 },
    ],
  } });
  assert.equal(line.karaoke, false);
  assert.equal(line.time_ms, 2000);
  assert.equal(line.finish_time_ms, 4000);
});
