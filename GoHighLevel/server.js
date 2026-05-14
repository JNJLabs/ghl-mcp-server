import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GOHL_API_KEY;
const GHL_LOCATION_ID = process.env.GOHL_ACCOUNT_ID;
const GHL_BASE = "https://services.leadconnectorhq.com";

// ── MCP discovery endpoint ──────────────────────────────────────────────────
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
            limit: {
              type: "number",
              description: "How many leads to fetch (default 20)"
            }
          }
        }
      },
      {
        name: "get_lead_details",
        description: "Get full details of a specific contact by ID",
        parameters: {
          type: "object",
          properties: {
            contact_id: {
              type: "string",
              description: "The GoHighLevel contact ID"
            }
          },
          required: ["contact_id"]
        }
      },
      {
        name: "update_lead_status",
        description: "Update a contact's tags or pipeline stage",
        parameters: {
          type: "object",
          properties: {
            contact_id: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to apply to the contact"
            }
          },
          required: ["contact_id"]
        }
      }
    ]
  });
});

// ── MCP tool execution endpoint ─────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const { tool, parameters } = req.body;

  try {
    if (tool === "list_recent_leads") {
      const limit = parameters?.limit || 20;
      const response = await fetch(
        `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&limit=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            Version: "2021-07-28"
          }
        }
      );
      const data = await response.json();
      return res.json({ result: data });
    }

    if (tool === "get_lead_details") {
      const response = await fetch(
        `${GHL_BASE}/contacts/${parameters.contact_id}`,
        {
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            Version: "2021-07-28"
          }
        }
      );
      const data = await response.json();
      return res.json({ result: data });
    }

    if (tool === "update_lead_status") {
      const response = await fetch(
        `${GHL_BASE}/contacts/${parameters.contact_id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            Version: "2021-07-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ tags: parameters.tags || [] })
        }
      );
      const data = await response.json();
      return res.json({ result: data });
    }

    res.status(400).json({ error: `Unknown tool: ${tool}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("GoHighLevel MCP Server is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP server running on port ${PORT}`));
