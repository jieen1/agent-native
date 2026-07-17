// S9 "引擎与模型" card's fallback-engine line — unit tests for
// get-brain-fallback-engine.ts. Pure env-var read + URL parsing, no DB.

import { describe, it, expect, afterEach } from "vitest";

import getBrainFallbackEngine from "./get-brain-fallback-engine.js";

const ORIGINAL_BASE_URL = process.env.OPENAI_BASE_URL;
const ORIGINAL_MODEL = process.env.OPENAI_MODEL;

function restoreEnv() {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_MODEL === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = ORIGINAL_MODEL;
}

describe("get-brain-fallback-engine", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("configured=false and endpointHost=null when OPENAI_BASE_URL is unset", async () => {
    delete process.env.OPENAI_BASE_URL;
    const result = await getBrainFallbackEngine.run({});
    expect(result.configured).toBe(false);
    expect(result.endpointHost).toBeNull();
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("configured=true and endpointHost parsed from a set OPENAI_BASE_URL", async () => {
    process.env.OPENAI_BASE_URL = "http://192.168.1.250:9000/v1";
    process.env.OPENAI_MODEL = "qwen3.6-27b";
    const result = await getBrainFallbackEngine.run({});
    expect(result.configured).toBe(true);
    expect(result.endpointHost).toBe("192.168.1.250:9000");
    expect(result.model).toBe("qwen3.6-27b");
  });

  it("never throws on a malformed OPENAI_BASE_URL — endpointHost degrades to null", async () => {
    process.env.OPENAI_BASE_URL = "not a url";
    const result = await getBrainFallbackEngine.run({});
    expect(result.configured).toBe(true);
    expect(result.endpointHost).toBeNull();
  });
});
