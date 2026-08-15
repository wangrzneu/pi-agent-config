import assert from "node:assert/strict";
import test from "node:test";
import { createSanitizedKubeconfig } from "./sanitized-kubeconfig.ts";

test("sanitized kubeconfig contains only gateway capabilities", () => {
  const output = createSanitizedKubeconfig([
    {
      context: "dev-admin",
      cluster: "dev",
      namespace: "team-a",
      gatewayServer: "https://127.0.0.1:41721/grants/dev",
      gatewayCaData: "ephemeral-ca",
      capability: "opaque-session-capability",
    },
    {
      context: "staging",
      cluster: "staging",
      gatewayServer: "https://127.0.0.1:41721/grants/staging",
      gatewayCaData: "ephemeral-ca",
      capability: "other-capability",
    },
  ], "dev-admin");
  const config = JSON.parse(output);

  assert.equal(config["current-context"], "dev-admin");
  assert.equal(config.contexts.length, 2);
  assert.equal(config.clusters[0].cluster.server, "https://127.0.0.1:41721/grants/dev");
  assert.equal(config.users[0].user.token, "opaque-session-capability");
  assert.doesNotMatch(output, /client-key|refresh-token|real.*token/i);
});

test("sanitized kubeconfig rejects duplicate and unknown current contexts", () => {
  const grant = {
    context: "dev",
    cluster: "dev",
    gatewayServer: "https://127.0.0.1/grants/dev",
    gatewayCaData: "ca",
    capability: "token",
  };
  assert.throws(() => createSanitizedKubeconfig([grant, grant]), /Duplicate Kubernetes context/);
  assert.throws(() => createSanitizedKubeconfig([grant], "prod"), /current context prod is not granted/);
});
