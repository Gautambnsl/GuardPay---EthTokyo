import { test, before, after } from "node:test";
import type { Server } from "node:http";
import assert from "node:assert/strict";
import express from "express";

process.env.WORLD_MODE = "mock";
process.env.AGENT_PORT = "4999";
const { mockWorldRouter } = await import("../src/mock-world.js");
const w = await import("../src/worldid.js");

const issuer = "http://localhost:4999/mock-world";
const intent = { invoiceId: 3, payTo: "0x4200000000000000000000000000000000000011", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "2000000", network: "eip155:84532" };
const act = (code: string, action: string) => fetch(`${issuer}/app/requests/${code}/${action}`, { method: "POST" });
const basic = "Basic " + Buffer.from("guardpay-treasury-agent:mock-secret").toString("base64");

let server: Server;
before(async () => {
  const app = express();
  app.use("/mock-world", await mockWorldRouter(issuer));
  await new Promise<void>((ok) => (server = app.listen(4999, ok)));
});
after(() => server.closeAllConnections() ?? server.close());

test("approved -> verified claims, consumable once for the same intent only", async () => {
  const a = await w.requestApproval(intent);
  await act(a.userCode, "approve");
  const done = await w.waitForApproval(a.id);
  assert.equal(done.status, "approved");
  assert.equal(done.claims?.acr, w.ORB_ACR);
  assert.throws(() => w.consumeApproval(a.id, { ...intent, amount: "9000000" }), /different payment/);
  w.consumeApproval(a.id, intent);
  assert.throws(() => w.consumeApproval(a.id, intent), /unknown approval/);
});

test("denied / expired / cancelled are never approved", async () => {
  const d = await w.requestApproval(intent);
  await act(d.userCode, "deny");
  assert.equal((await w.waitForApproval(d.id)).status, "denied");

  const e = await w.requestApproval(intent, { ttlSeconds: 2 });
  assert.equal((await w.waitForApproval(e.id)).status, "expired");

  const c = await w.requestApproval(intent);
  setTimeout(() => w.cancelApproval(c.id), 300);
  assert.equal((await w.waitForApproval(c.id)).status, "cancelled");
  assert.throws(() => w.consumeApproval(c.id, intent), /cancelled/);
});

async function mintToken() {
  const dev = await (await fetch(`${issuer}/api/v1/device_authorization`, { method: "POST", headers: { authorization: basic } })).json();
  await act(dev.user_code, "approve");
  const tok = await (await fetch(`${issuer}/api/v1/token`, {
    method: "POST",
    headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dev.device_code }),
  })).json();
  return tok.id_token as string;
}

test("backend rejects replayed, stale, tampered and wrong-audience tokens", async () => {
  const t0 = Date.now();
  const token = await mintToken();
  await w.verifyApprovalToken(token, { requestedAt: t0, intentHash: "x" });
  await assert.rejects(w.verifyApprovalToken(token, { requestedAt: t0, intentHash: "x" }), /replayed/);

  const stale = await mintToken();
  await assert.rejects(w.verifyApprovalToken(stale, { requestedAt: Date.now() + 60_000, intentHash: "x" }), /stale/);

  const good = await mintToken();
  const [h, p, s] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sub: "attacker" })).toString("base64url");
  await assert.rejects(w.verifyApprovalToken(`${h}.${forged}.${s}`, { requestedAt: t0, intentHash: "x" }), /signature/);

  const other = await mintToken();
  await assert.rejects(
    w.verifyApprovalToken(other, { requestedAt: t0, intentHash: "x" }, { ...w.worldConfig(), clientId: "some-other-app" }),
    /aud/,
  );
});
