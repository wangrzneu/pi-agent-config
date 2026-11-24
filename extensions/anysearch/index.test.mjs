import assert from "node:assert/strict";
import test from "node:test";

import { registerAnySearch } from "./index.ts";

function harness(options = {}) {
  let tool;
  registerAnySearch({ registerTool(definition) { tool = definition; } }, options);
  return tool;
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("registers a read-only, open-world anysearch tool", () => {
  const tool = harness();
  assert.equal(tool.name, "anysearch");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(tool.namespace.name, "anysearch");
});

test("search returns formatted results and stable details", async () => {
  const tool = harness({
    fetchImpl: async () => jsonResponse({
      results: [{ title: "Result", url: "https://example.com", content: "Body" }],
      metadata: { total_results: 1, search_time_ms: 5 },
    }),
  });
  const result = await tool.execute("call", {
    command: "search",
    query: "hello",
    max_results: 3,
  }, undefined, undefined);
  assert.match(result.content[0].text, /Result/);
  assert.deepEqual(result.details, {
    command: "search",
    query: "hello",
    resultCount: 1,
    totalResults: 1,
  });
});

test("batch_search applies shared fields and reports failures", async () => {
  const bodies = [];
  const tool = harness({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.query === "bad"
        ? new Response(JSON.stringify({ code: -1, message: "nope" }), { status: 200 })
        : jsonResponse({ results: [{ title: body.query }] });
    },
  });
  const result = await tool.execute("call", {
    command: "batch_search",
    queries: [{ query: "good" }, { query: "bad" }],
    tag: "finance.quote",
    max_results: 2,
  }, undefined, undefined);
  assert.deepEqual(bodies[0], {
    query: "good",
    tag: "finance.quote",
    max_results: 2,
  });
  assert.equal(result.details.queries, 2);
  assert.equal(result.details.failures, 1);
  assert.match(result.content[0].text, /Search failed: nope/);
});

test("extract and get_sub_domains pass through the client", async () => {
  const calls = [];
  const tool = harness({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/sub-domains")) {
        return jsonResponse({
          domains: [{ domain: "finance", sub_domains: [{ sub_domain: "finance.quote" }] }],
        });
      }
      return jsonResponse({ title: "Page", url: "https://example.com", content: "content" });
    },
  });

  const extracted = await tool.execute("call", {
    command: "extract",
    url: "https://example.com",
  }, undefined, undefined);
  assert.equal(extracted.details.command, "extract");
  assert.match(extracted.content[0].text, /untrusted/);

  const domains = await tool.execute("call", {
    command: "get_sub_domains",
    domains: ["finance"],
  }, undefined, undefined);
  assert.equal(domains.details.subDomainCount, 1);
  assert.match(domains.content[0].text, /finance\.quote/);
});

test("invalid command arguments fail closed", async () => {
  const tool = harness({ fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(tool.execute("call", { command: "search" }, undefined, undefined), /needs a query/);
  await assert.rejects(tool.execute("call", { command: "extract" }, undefined, undefined), /needs a url/);
  await assert.rejects(tool.execute("call", { command: "get_sub_domains" }, undefined, undefined), /needs domains/);
});

test("ANYSEARCH_ENABLED=0 disables registration", () => {
  const previous = process.env.ANYSEARCH_ENABLED;
  process.env.ANYSEARCH_ENABLED = "0";
  try {
    let registered = false;
    registerAnySearch({ registerTool() { registered = true; } });
    assert.equal(registered, false);
  } finally {
    if (previous === undefined) delete process.env.ANYSEARCH_ENABLED;
    else process.env.ANYSEARCH_ENABLED = previous;
  }
});
