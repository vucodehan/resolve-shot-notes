import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClipName, releaseFromProject } from "../episodes.js";

test("a project name binds to its release", () => {
  const r = "episode-01-example";
  assert.equal(releaseFromProject(r), r);
  assert.equal(releaseFromProject(`${r} (2)`), r);
  assert.equal(releaseFromProject(`${r} (mixed)`), r);
  assert.equal(releaseFromProject(`${r} (mixed) (2)`), r);
  assert.equal(releaseFromProject(`${r} (Mixed)`), r);
  assert.equal(releaseFromProject(`${r} (mixed test)`), `${r} (mixed test)`);
  assert.equal(releaseFromProject("episode-02-example rebuild"), "episode-02-example rebuild");
});

test("the panel's picture clips parse, its line clips do not", () => {
  assert.deepEqual(parseClipName("S15-v7.mp4"), { sid: "S15", version: "v7" });
  assert.equal(parseClipName("S15-v7.line.wav"), null);
});
