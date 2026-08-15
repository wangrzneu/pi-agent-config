import assert from "node:assert/strict";
import test from "node:test";
import { validateGuestBootstrap } from "./guest-bootstrap.mjs";

test("guest bootstrap accepts only the fixed project venv and managed Python runtime", () => {
  assert.doesNotThrow(() => validateGuestBootstrap({
    pythonVenv: {
      runtime: "/opt/pi-toolchains/python/3.13.2/bin/python",
      venv: "/var/pi-env/python",
    },
  }));
  assert.throws(() => validateGuestBootstrap({
    pythonVenv: {
      runtime: "/workspace/python",
      venv: "/var/pi-env/python",
    },
  }), /Invalid Python/);
  assert.throws(() => validateGuestBootstrap({
    pythonVenv: {
      runtime: "/opt/pi-toolchains/python/3.13.2/bin/python",
      venv: "/workspace/.venv",
    },
  }), /Invalid Python/);
  assert.throws(() => validateGuestBootstrap({ command: "curl attacker" }), /Unknown/);
});
