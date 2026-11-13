import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTrailingJson } from "../src/extractJson.js";

test("plain JSON object", () => {
  const r = extractTrailingJson('{"a":1}');
  assert.deepEqual(r.json, { a: 1 });
});

test("JSON wrapped in a json code fence", () => {
  const r = extractTrailingJson('```json\n{"a":1}\n```');
  assert.deepEqual(r.json, { a: 1 });
});

test("JSON wrapped in a plain code fence", () => {
  const r = extractTrailingJson('```\n{"a":1}\n```');
  assert.deepEqual(r.json, { a: 1 });
});

test("lead-in text before the JSON", () => {
  const r = extractTrailingJson('Here is my report:\n{"summary":"s","findings":[]}');
  assert.deepEqual(r.json, { summary: "s", findings: [] });
});

test("text after the JSON is ignored", () => {
  const r = extractTrailingJson('{"a":1}\nThat is all.');
  assert.deepEqual(r.json, { a: 1 });
});

test("nested object prefers the outermost", () => {
  const r = extractTrailingJson('lead {"a":{"b":2}}');
  assert.deepEqual(r.json, { a: { b: 2 } });
});

test("braces inside strings do not break balance", () => {
  const r = extractTrailingJson('{"s":"x } y","n":2}');
  assert.deepEqual(r.json, { s: "x } y", n: 2 });
});

test("empty / no JSON returns null", () => {
  assert.equal(extractTrailingJson(""), null);
  assert.equal(extractTrailingJson("no json here"), null);
  assert.equal(extractTrailingJson("unclosed { brace"), null);
});

test("a single balanced object inside junk is still recovered", () => {
  const r = extractTrailingJson("{}junk");
  assert.deepEqual(r.json, {});
});

test("raw newlines inside string values are tolerated", () => {
  const r = extractTrailingJson('Here is a report:\n{"summary":"line one\nline two","findings":[]}\nThat is all.');
  assert.deepEqual(r.json, { summary: "line one\nline two", findings: [] });
});

test("object-like prose before the JSON is not picked over the real report", () => {
  const text =
    'Confirmed in diff (`neverAsked={}` appended), ships under test-only framing.\n' +
    'Final report:\n{"schema_version":"1.0","summary":"s","findings":[],"notes":["a","b"]}';
  const r = extractTrailingJson(text);
  assert.deepEqual(r.json, { schema_version: "1.0", summary: "s", findings: [], notes: ["a", "b"] });
});