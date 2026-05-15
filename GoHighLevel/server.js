import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

const GHL_API_KEY = process.env.GOHL_API_KEY;
const GHL_LOCATION_ID = process.env.GOHL_ACCOUNT_ID;
const GHL_BASE = "https://services.leadconnectorhq.com";
const BASE_URL = "https://earnest-motivation-production-a681.up.railway.app";

// Store auth codes in memory
const authCodes = new Map();

// ── OAuth metadata ───────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"]
  });
});

// ── OAuth dynamic client registration ────────────────────────────────
app.post("/oauth/register", (req, res) => {
  const clientId = "ghl-client-" + crypto.randomBytes(8).toString("hex");
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body.redirect_uris || [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
});

// ── OAuth authorize ───────────────────────────────────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = req.query;
  const code = crypto.randomBytes(16).toString("hex");
  authCodes.set(code, { redirect_uri, state, code_challenge, code_challenge_method, client_id, created: Date.now() });
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

// ── OAuth token ─────────────────────────────────────────────────────────────
app.post("/oauth/token", (req, res) => {
  const { code, code_verifier, grant_type } = req.body;
  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  const stored = authCodes.get(code);
  if (!stored) {
    return res.status(400).json({ error: "invalid_grant" });
  }
  // Verify PKCE
  if (stored.code_challenge) {
    if (stored.code_challenge_method === "S256") {
      const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
      if (hash !== stored.code_challenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
    } else if (stored.code_challenge_method === "plain") {
      if (code_verifier !== stored.code_challenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
    }
  }
  authCodes.delete(code);
  const accessToken = crypto.randomBytes(32).toString("hex");
  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 86400
  });
});

// ── MCP discovery endpoint ───────────────────────────────────────────────────
app.get("/mcp", (req, res) => {
  res.json({
    schema_version: "v1",
    name: "GoHighLevel MCP",
    description: "MCP server for GoHighLevel CRM - Real Estate",
    tools: [
      {
        name: "list_recent_leads",
        description: "Get recent contacts/leads from GoHighLevel",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "How many leads to fetch (default 20)" }
          }
        }
      },
      {
        name: "get_lead_details",
        description: "Get full details of a specific contact by ID",
        parameters: {
          type: "object",
          properties: {
            contact_id: { type: "string", description: "The GoHighLevel contact ID" }
          },
          required: ["contact_id"]
        }
      },
      {
        name: "update_lead_status",
        description: "Update a contact tags or pipeline stage",
        parameters: {
          type: "object",
          properties: {
            contact_id: { type: "string" },
            tags: { type: "array", items: { type: "string" }, description: "Tags to apply" }
          },
          required: ["contact_id"]
        }
      }
    ]
  });
});

// ── MCP tool execution ──────────────────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const { tool, parameters } = req.body;
  try {
    if (tool === "list_recent_leads") {
      const limit = parameters?.limit || 20;
      const response = await fetch(`${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28" }
      });
      return res.json({ result: await response.json() });
    }
    if (tool === "get_lead_details") {
      const response = await fetch(`${GHL_BASE}/contacts/${parameters.contact_id}`, {
        headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28" }
      });
      return res.json({ result: await response.json() });
    }
    if (tool === "update_lead_status") {
      const response = await fetch(`${GHL_BASE}/contacts/${parameters.contact_id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28", "Content-Type": "application/json" },
        body: JSON.stringify({ tags: parameters.tags || [] })
      });
      return res.json({ result: await response.json() });
    }
    res.status(400).json({ error: `Unknown tool: ${tool}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("GoHighLevel MCP Server is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP server running on port ${PORT}`));
