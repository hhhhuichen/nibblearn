import assert from "node:assert/strict";
import test from "node:test";
import { modelRunner } from "../src/model-runner.ts";
import { LearnError, ModelRunError } from "../src/types.ts";
import { emptyUsage } from "../src/usage.ts";

function harness(stopReason = "stop", text = '{"body":"complete"}', failRequest = false) {
  const requests: { context: { systemPrompt: string; messages: unknown[] }; options: { maxTokens: number } }[] = [];
  const usage = { ...emptyUsage(), input: 10, output: 20, totalTokens: 30 };
  const context = {
    model: { input: ["text"], maxTokens: 8192, contextWindow: 131072 },
    modelRegistry: {
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        requests.push({ context, options } as typeof requests[number]);
        return { result: async () => {
          if (failRequest) throw new Error("private-provider-secret");
          return { stopReason, content: [{ type: "text", text }], usage, errorMessage: "private-provider-secret" };
        } };
      },
    },
  };
  return { context, requests, usage, run: () => modelRunner(context as unknown as Parameters<typeof modelRunner>[0]) };
}

for (const [reason, code] of [["length", "MODEL_OUTPUT_LIMIT"], ["error", "MODEL_RESPONSE_ERROR"], ["toolUse", "MODEL_INCOMPLETE"], ["unrecognized", "MODEL_INCOMPLETE"]]) {
  test(`classifies ${reason} without a retry or raw provider details`, async () => {
    const h = harness(reason);
    await assert.rejects(h.run()({ system: "system", prompt: "{}", maxTokens: 4096 }), error => {
      assert.ok(error instanceof ModelRunError);
      assert.equal(error.code, code);
      assert.equal(error.diagnostics?.stopReason, reason === "unrecognized" ? "unknown" : reason);
      assert.equal(error.diagnostics?.maxTokens, 4096);
      assert.equal(error.usage?.totalTokens, 30);
      assert.ok(!JSON.stringify(error).includes("private-provider-secret"));
      return true;
    });
    assert.equal(h.requests.length, 1);
  });
}

test("successful output stays complete and receives a bounded capacity hint", async () => {
  const h = harness();
  const result = await h.run()({ system: "system", prompt: "{}" });
  assert.equal(result.text, '{"body":"complete"}');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.context.messages.length, 1);
  assert.match(h.requests[0]!.context.systemPrompt, /8192 tokens/);
  assert.ok(Buffer.byteLength(h.requests[0]!.context.systemPrompt.slice("system".length), "utf8") < 1024);
});

test("request exception is distinct from output truncation and does not leak its message", async () => {
  const h = harness("stop", "", true);
  await assert.rejects(h.run()({ system: "system", prompt: "{}" }), error => {
    assert.ok(error instanceof ModelRunError);
    assert.equal(error.code, "MODEL_REQUEST_FAILED");
    assert.equal(error.diagnostics?.stopReason, "request_failed");
    assert.ok(!JSON.stringify(error).includes("private-provider-secret"));
    return true;
  });
  assert.equal(h.requests.length, 1);
});

test("empty normal response is not accepted as a completed note", async () => {
  const h = harness("stop", "  ");
  await assert.rejects(h.run()({ system: "system", prompt: "{}" }), error => error instanceof ModelRunError && error.code === "MODEL_EMPTY_OUTPUT");
  assert.equal(h.requests.length, 1);
});

test("insufficient context fails before spending or truncating input", async () => {
  const h = harness();
  h.context.model.contextWindow = 1024;
  await assert.rejects(h.run()({ system: "system", prompt: "{}" }), error => error instanceof LearnError && error.code === "MODEL_CONTEXT");
  assert.equal(h.requests.length, 0);
});

test("available context bounds the requested output limit", async () => {
  const h = harness();
  h.context.model.contextWindow = 2048;
  await h.run()({ system: "system", prompt: "{}" });
  assert.equal(h.requests[0]?.options.maxTokens, 2048 - Buffer.byteLength("system{}") - 1024);
});

test("model cancellation is not turned into an output-limit error", async () => {
  const h = harness("aborted");
  await assert.rejects(h.run()({ system: "system", prompt: "{}" }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(h.requests.length, 1);
});
