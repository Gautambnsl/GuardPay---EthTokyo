import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { HTTPRequestContext } from "@x402/core/http";
import { captureConsole, cfg, formatUsdc, getInvoice, logsSince, NETWORK } from "@guardpay/shared";

captureConsole("seller");

/**
 * Supplier invoice gateway. POST /invoices/:id/pay is paywalled with x402:
 * price = invoice amount (USDC), payTo = invoice supplier (both read from the InvoiceToken).
 */
const app = express();
app.use(express.json());

// Request log: shows the x402 handshake (402 challenge, then paid retry) in the dashboard console.
app.use((req, res, next) => {
  if (req.path === "/logs") return next();
  const paid = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
  const t0 = Date.now();
  res.on("finish", () => {
    const note =
      res.statusCode === 402 ? (paid ? "payment rejected" : "Payment Required → quote sent")
      : paid && res.statusCode === 200 ? `payment verified + settled by facilitator${res.getHeader("payment-response") ? " (tx in PAYMENT-RESPONSE)" : ""}`
      : "";
    console.log(`[seller] ${req.method} ${req.path}${paid ? " +PAYMENT-SIGNATURE" : ""} → ${res.statusCode} ${note} (${Date.now() - t0}ms)`);
  });
  next();
});

app.get("/logs", (req, res) => res.json(logsSince(Number(req.query.since ?? 0))));

const invoiceIdFrom = (ctx: HTTPRequestContext) => Number(ctx.path.split("/")[2]);

async function requireInvoice(ctx: HTTPRequestContext) {
  const inv = await getInvoice(invoiceIdFrom(ctx));
  if (!inv) throw new Error(`Unknown invoice ${ctx.path}`);
  return inv;
}

// Free: invoice details, so the agent can see what it's being asked to pay.
app.get("/invoices/:id", async (req, res) => {
  const inv = await getInvoice(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: "unknown invoice" });
  res.json({ ...inv, amount: inv.amount.toString(), amountUsdc: formatUsdc(inv.amount) });
});

// Reject unknown / already-paid invoices before any payment is requested.
app.post("/invoices/:id/pay", async (req, res, next) => {
  const inv = await getInvoice(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: "unknown invoice" });
  if (inv.paid) return res.status(409).json({ error: "invoice already paid" });
  next();
});

app.use(
  paymentMiddleware(
    {
      "POST /invoices/:id/pay": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            payTo: async (ctx) => (await requireInvoice(ctx)).supplier,
            price: async (ctx) => `$${formatUsdc((await requireInvoice(ctx)).amount)}`,
            maxTimeoutSeconds: 300,
          },
        ],
        description: "Settle a tokenized supplier invoice",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl() })).register(
      NETWORK,
      new ExactEvmScheme(),
    ),
  ),
);

app.post("/invoices/:id/pay", async (req, res) => {
  const inv = await getInvoice(Number(req.params.id));
  res.json({
    status: "accepted",
    invoiceId: Number(req.params.id),
    supplier: inv?.supplier,
    amountUsdc: inv ? formatUsdc(inv.amount) : undefined,
    receivedAt: new Date().toISOString(),
  });
});

app.listen(cfg.sellerPort(), () => {
  console.log(`[seller] x402 invoice gateway on http://localhost:${cfg.sellerPort()} (${NETWORK})`);
  console.log(`[seller] invoices from ${cfg.invoiceToken() ? `InvoiceToken ${cfg.invoiceToken()}` : "local demo registry"}`);
});
