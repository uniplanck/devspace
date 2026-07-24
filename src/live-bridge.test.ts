import assert from "node:assert/strict";
import { parseLiveBridgeIntent } from "./live-bridge.js";

const gitStatus = parseLiveBridgeIntent("このリポジトリの未コミット変更を確認して");
assert.equal(gitStatus.executable, true);
assert.equal(gitStatus.preset, "git-status");
assert.equal(gitStatus.requiresConfirmation, false);

const build = parseLiveBridgeIntent("ビルドして");
assert.equal(build.executable, true);
assert.equal(build.preset, "build");
assert.equal(build.requiresConfirmation, true);

const dangerous = parseLiveBridgeIntent("mainにpushして本番デプロイして");
assert.equal(dangerous.executable, false);
assert.equal(dangerous.preset, undefined);

const empty = parseLiveBridgeIntent("   ");
assert.equal(empty.executable, false);
assert.equal(empty.reason, "transcript is required");

console.log("live-bridge tests passed");
