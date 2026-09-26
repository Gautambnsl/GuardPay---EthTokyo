import { test } from "node:test";
import assert from "node:assert/strict";
import { addressVerdict, messageVerdict, tokenVerdict, worst } from "../src/intercepta.js";
import { decide } from "../src/policy.js";

const limits = { autoPayLimit: 1_000_000n, capLimit: 100_000n };

test("policy: clean + small -> PAY, clean + large -> ESCALATE", () => {
  assert.equal(decide("CLEAN", 50_000n, limits).decision, "PAY");
  assert.equal(decide("CLEAN", 1_000_000n, limits).decision, "PAY");
  assert.equal(decide("CLEAN", 2_000_000n, limits).decision, "ESCALATE");
});

test("policy: BLOCK always REFUSE, HOLD always ESCALATE", () => {
  assert.equal(decide("BLOCK", 1n, limits).decision, "REFUSE");
  assert.equal(decide("HOLD", 1n, limits).decision, "ESCALATE");
});

test("policy: CAUTION caps", () => {
  assert.equal(decide("CAUTION", 50_000n, limits).decision, "CAP");
  assert.equal(decide("CAUTION", 500_000n, limits).decision, "ESCALATE");
});

test("address verdicts", () => {
  assert.equal(addressVerdict({ toxicScore: 0, traits: [] }).verdict, "CLEAN");
  assert.equal(addressVerdict({ toxicScore: 10, traits: [] }).verdict, "CAUTION");
  assert.equal(addressVerdict({ toxicScore: 50, traits: [] }).verdict, "HOLD");
  assert.equal(addressVerdict({ toxicScore: 90, traits: [] }).verdict, "BLOCK");
  assert.equal(
    addressVerdict({ toxicScore: 5, traits: [{ name: "known_scammer", risk: 1, txsCount: 3, description: "" }] }).verdict,
    "BLOCK",
  );
});

test("token + message verdicts", () => {
  const tok = { riskScore: 0, riskLevel: "neutral", trust: "whitelist", action: "info", detectors: [] } as const;
  assert.equal(tokenVerdict({ ...tok, detectors: [] }).verdict, "CLEAN");
  assert.equal(tokenVerdict({ ...tok, detectors: [], action: "block" }).verdict, "BLOCK");
  assert.equal(messageVerdict({ riskGroup: "Low", detectors: [] }).verdict, "CLEAN");
  assert.equal(messageVerdict({ riskGroup: "Medium", detectors: [] }).verdict, "HOLD");
  assert.equal(messageVerdict({ riskGroup: "Low", detectors: [{ code: "WALLET_DRAINER", description: "" }] }).verdict, "BLOCK");
  assert.equal(worst(["CLEAN", "HOLD", "CAUTION"]), "HOLD");
});
