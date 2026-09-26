import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { HTTPRequestContext } from "@x402/core/http";
import { cfg, formatUsdc, getInvoice, NETWORK } from "@guardpay/shared";

/**
 * Supplier invoice gateway. POST /invoices/:id/pay is paywalled with x402:
 * price = invoice amount (USDC), payTo = invoice supplier (both read from the InvoiceToken).
 */
const app = express();
app.use(express.json());

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
