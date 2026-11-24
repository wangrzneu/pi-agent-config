import assert from "node:assert/strict";
import test from "node:test";

import {
  AnySearchError,
  batchSearch,
  extract,
  formatBatchResponse,
  formatExtractResponse,
  formatSearchResponse,
  formatSubDomains,
  getSubDomains,
  search,
} from "./client.ts";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler({ url: String(url), init });
  };
  return { calls, fetchImpl };
}

test("search posts the expected body and formats results", async () => {
  const fake = fakeFetch(() => jsonResponse({
    results: [
      { title: "Example", url: "https://example.com", content: "A result" },
    ],
    metadata: { total_results: 1, search_time_ms: 12 },
  }));

  const response = await search(
    { apiKey: "secret", fetchImpl: fake.fetchImpl },
    { query: "hello", max_results: 99 },
  );

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, "https://api.anysearch.com/v1/search");
  assert.equal(fake.calls[0].init.method, "POST");
  assert.equal(fake.calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(fake.calls[0].init.body), {
    query: "hello",
    max_results: 10,
  });
  assert.match(formatSearchResponse(response), /Example/);
  assert.match(formatSearchResponse(response), /https:\/\/example\.com/);
});

test("anonymous search omits Authorization", async () => {
  const fake = fakeFetch(() => jsonResponse({ results: [] }));
  await search({ fetchImpl: fake.fetchImpl }, { query: "hello" });
  assert.equal("Authorization" in fake.calls[0].init.headers, false);
});

test("getSubDomains uses GET query parameters and formats params", async () => {
  const fake = fakeFetch(() => jsonResponse({
    domains: [
      {
        domain: "finance",
        sub_domains: [
          {
            sub_domain: "finance.quote",
            description: "Stock quotes",
            params: {
              symbol: { description: "Ticker", required: true, sort_order: 1 },
            },
          },
        ],
      },
    ],
  }));

  const domains = await getSubDomains({ fetchImpl: fake.fetchImpl }, ["finance", "finance"]);
  assert.equal(fake.calls[0].init.method, "GET");
  assert.match(fake.calls[0].url, /\/v1\/sub-domains\?domain=finance$/);
  assert.match(formatSubDomains(domains), /finance\.quote/);
  assert.match(formatSubDomains(domains), /symbol.*required/);
});

test("extract rejects non-http URLs and formats untrusted content", async () => {
  await assert.rejects(
    extract({ fetchImpl: async () => jsonResponse({}) }, "file:///etc/passwd"),
    AnySearchError,
  );

  const fake = fakeFetch(() => jsonResponse({
    title: "Page",
    url: "https://example.com/page",
    content: "# Body",
  }));
  const response = await extract({ fetchImpl: fake.fetchImpl }, "https://example.com/page");
  assert.deepEqual(JSON.parse(fake.calls[0].init.body), { url: "https://example.com/page" });
  assert.match(formatExtractResponse(response), /untrusted/);
  assert.match(formatExtractResponse(response), /# Body/);
});

test("batchSearch bounds the batch and reports per-query failures", async () => {
  await assert.rejects(
    batchSearch({ fetchImpl: async () => jsonResponse({}) }, []),
    AnySearchError,
  );
  await assert.rejects(
    batchSearch(
      { fetchImpl: async () => jsonResponse({}) },
      Array.from({ length: 6 }, (_, index) => ({ query: `q${index}` })),
    ),
    AnySearchError,
  );

  const fake = fakeFetch(({ init }) => {
    const query = JSON.parse(init.body).query;
    if (query === "bad") {
      return new Response(JSON.stringify({ code: -1, message: "failed" }), { status: 200 });
    }
    return jsonResponse({ results: [{ title: query }] });
  });
  const results = await batchSearch(
    { fetchImpl: fake.fetchImpl },
    [{ query: "good" }, { query: "bad" }],
  );
  assert.equal(results[0].response.results[0].title, "good");
  assert.match(results[1].error, /failed/);
  assert.match(formatBatchResponse(results), /Search failed: failed/);
});

test("API errors expose status and request id", async () => {
  const fake = fakeFetch(() => new Response(
    JSON.stringify({ code: -1, message: "Rate limited", request_id: "req-1" }),
    { status: 429 },
  ));
  await assert.rejects(
    search({ fetchImpl: fake.fetchImpl }, { query: "q" }),
    (error) => error instanceof AnySearchError
      && error.status === 429
      && error.requestId === "req-1"
      && /Rate limited/.test(error.message),
  );
});
