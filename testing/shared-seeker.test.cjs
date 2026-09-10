const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ window: { matchMedia: () => ({ matches: false }) } });
vm.runInContext(readFileSync(join(__dirname, "../site/shared-ui.js"), "utf8"), context);

function seeker() {
  const input = new EventTarget();
  const positions = [];
  let focused = false;
  let ended = 0;
  input.value = "0";
  input.focus = (options) => { focused = options.preventScroll; };
  input.setPointerCapture = () => {};
  context.window.TouchzoukUI.bindSeeker({
    input,
    surface: { getBoundingClientRect: () => ({ left: 100, width: 1000 }) },
    onSeek: (ratio) => { positions.push(ratio); input.value = String(Math.round(ratio * 1000)); },
    onSeekEnd: () => { ended += 1; },
  });
  const pointer = (type, clientX, pointerId = 1, button = 0) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX, pointerId, button });
    input.dispatchEvent(event);
    return event;
  };
  return { input, positions, pointer, focused: () => focused, ended: () => ended };
}

test("pointer seek prevents a native mouseup value from replacing the waveform position", () => {
  const s = seeker();
  const down = s.pointer("pointerdown", 160);
  s.pointer("pointerup", 160);
  // Firefox's compatibility mouse events use the native thumb geometry.
  if (!down.defaultPrevented) {
    s.input.value = "49";
    s.input.dispatchEvent(new Event("input"));
  }
  assert.equal(s.positions.at(-1), 0.06);
  assert.equal(s.focused(), true);
  assert.equal(s.ended(), 1);
});

test("drag keeps pointer ownership and cancellation restores keyboard seeking", () => {
  const s = seeker();
  s.pointer("pointerdown", 200);
  s.pointer("pointerdown", 800, 2);
  s.pointer("pointermove", 900, 2);
  s.pointer("pointerup", 900, 2);
  assert.deepEqual(s.positions, [0.1]);
  s.pointer("pointermove", 400);
  assert.equal(s.positions.at(-1), 0.3);
  s.pointer("pointercancel", 400);
  s.pointer("pointermove", 600);
  assert.equal(s.positions.at(-1), 0.3);
  s.input.value = "700";
  s.input.dispatchEvent(new Event("input"));
  assert.equal(s.positions.at(-1), 0.7);
  assert.equal(s.ended(), 1);
});

test("secondary click leaves seeking and the context menu untouched", () => {
  const s = seeker();
  const down = s.pointer("pointerdown", 400, 1, 2);
  s.pointer("pointerup", 400, 1, 2);
  assert.equal(down.defaultPrevented, false);
  assert.equal(s.focused(), false);
  assert.deepEqual(s.positions, []);
  assert.equal(s.ended(), 0);
});
