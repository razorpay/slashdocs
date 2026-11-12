import { assert, test } from "vitest";
import { addPoints, newTrack, playback } from "../bridge/cursors.ts";

const at = (t: number, x = 0) => ({ t, path: "0", x, y: 0 });

test("playback runs behind the newest point and moves between points", () => {
  const track = newTrack();
  // Sent at 1000 to 1080 on the sender's clock, received at 5100.
  addPoints(track, [at(1000, 0), at(1040, 0.5), at(1080, 1)], 5100);
  assert.strictEqual(track.offset, 4020);
  assert.ok(track.delay >= 80, "the delay covers the batch");

  assert.strictEqual(playback(track, 5100), null, "nothing plays before the delay");
  const middle = playback(track, 1020 + track.offset + track.delay);
  assert.deepEqual([middle?.from.x, middle?.to.x, middle?.f], [0, 0.5, 0.5]);
  const end = playback(track, 2000 + track.offset + track.delay);
  assert.deepEqual([end?.from.x, end?.to.x, end?.f], [1, 1, 0], "it rests on the last");
  assert.strictEqual(track.points.length, 1, "passed points are dropped");
});

test("old and repeated points are ignored, and a hidden point hides", () => {
  const track = newTrack();
  addPoints(track, [at(100), at(200)], 1000);
  addPoints(track, [at(150), at(200)], 1050);
  assert.deepEqual(
    track.points.map((point) => point.t),
    [100, 200],
  );
  addPoints(track, [{ ...at(300), hidden: true }], 1100);
  assert.strictEqual(playback(track, 10_000), null);
});

test("a move after a rest takes a short step, not the whole rest", () => {
  const track = newTrack();
  addPoints(track, [at(0, 0)], 100);
  addPoints(track, [at(10_000, 1)], 10_100);
  const start = 10_000 - 50 + track.offset + track.delay;
  assert.strictEqual(playback(track, start - 1000)?.f, 0, "it rests until the step");
  assert.strictEqual(playback(track, start + 25)?.f, 0.5);
});

test("the delay grows for late batches and the offset keeps the fastest", () => {
  const track = newTrack();
  addPoints(track, [at(0), at(80)], 100);
  const delay = track.delay;
  // This batch is 300 ms late.
  addPoints(track, [at(100), at(180)], 500);
  assert.strictEqual(track.offset, 21, "the offset rises by at most the drift");
  assert.ok(track.delay > delay + 200, "the delay covers the late batch");
});
