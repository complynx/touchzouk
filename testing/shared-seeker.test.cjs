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
  let started = 0;
  let ended = 0;
  input.value = "0";
  input.setPointerCapture = () => {};
  context.window.TouchzoukUI.bindSeeker({
    input,
    onSeek: (ratio) => { positions.push(ratio); input.value = String(Math.round(ratio * 1000)); },
    onSeekStart: () => { started += 1; },
    onSeekEnd: () => { ended += 1; },
  });
  const pointer = (type, clientX, pointerId = 1, button = 0) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX, pointerId, button });
    input.dispatchEvent(event);
    return event;
  };
  const value = (value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };
  return { input, positions, pointer, value, started: () => started, ended: () => ended };
}

test("only native input changes playback, including an input after pointerup", () => {
  const s = seeker();
  const down = s.pointer("pointerdown", 160);
  assert.equal(down.defaultPrevented, false);
  assert.deepEqual(s.positions, []);
  s.value(60);
  s.pointer("pointermove", 400);
  assert.deepEqual(s.positions, [0.06]);
  s.value(300);
  s.pointer("pointerup", 160);
  assert.deepEqual(s.positions, [0.06, 0.3]);
  s.value(301);
  assert.deepEqual(s.positions, [0.06, 0.3, 0.301]);
  assert.equal(s.started(), 1);
  assert.equal(s.ended(), 1);
});

test("drag keeps pointer ownership and cancellation restores keyboard seeking", () => {
  const s = seeker();
  s.pointer("pointerdown", 200);
  s.pointer("pointerdown", 800, 2);
  s.pointer("pointermove", 900, 2);
  s.pointer("pointerup", 900, 2);
  assert.equal(s.started(), 1);
  assert.equal(s.ended(), 0);
  s.value(300);
  s.pointer("pointercancel", 400);
  s.pointer("pointermove", 600);
  assert.equal(s.positions.at(-1), 0.3);
  s.value(700);
  assert.equal(s.positions.at(-1), 0.7);
  assert.equal(s.ended(), 1);
});

test("secondary click leaves seeking and the context menu untouched", () => {
  const s = seeker();
  const down = s.pointer("pointerdown", 400, 1, 2);
  s.pointer("pointerup", 400, 1, 2);
  assert.equal(down.defaultPrevented, false);
  assert.equal(s.started(), 0);
  assert.deepEqual(s.positions, []);
  assert.equal(s.ended(), 0);
});
