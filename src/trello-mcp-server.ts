#!/usr/bin/env node
/**
 * Trello MCP Server — exposes Trello REST API as MCP tools.
 * Runs as a stdio MCP server, configured in .mcp.json.
 *
 * Required env vars: TRELLO_API_KEY, TRELLO_API_TOKEN
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env["TRELLO_API_KEY"];
const API_TOKEN = process.env["TRELLO_API_TOKEN"];

if (!API_KEY || !API_TOKEN) {
  console.error("TRELLO_API_KEY and TRELLO_API_TOKEN must be set");
  process.exit(1);
}

const BASE = "https://api.trello.com/1";

async function trelloFetch(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", API_KEY!);
  url.searchParams.set("token", API_TOKEN!);

  const init: RequestInit = { method, headers: {} };
  if (body && (method === "POST" || method === "PUT")) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "trello",
  version: "1.0.0",
});

// --- Read tools ---

server.tool(
  "list_boards",
  "List all Trello boards for the authenticated user",
  { filter: z.enum(["all", "open", "closed"]).default("open").describe("Board filter") },
  async ({ filter }) => {
    const boards = await trelloFetch(`/members/me/boards?filter=${filter}&fields=name,url,shortUrl,closed,dateLastActivity`);
    return { content: [{ type: "text" as const, text: JSON.stringify(boards, null, 2) }] };
  }
);

server.tool(
  "get_board",
  "Get details of a specific Trello board",
  { boardId: z.string().describe("Board ID") },
  async ({ boardId }) => {
    const board = await trelloFetch(`/boards/${boardId}?fields=name,desc,url,shortUrl,closed,dateLastActivity`);
    return { content: [{ type: "text" as const, text: JSON.stringify(board, null, 2) }] };
  }
);

server.tool(
  "get_lists",
  "Get all lists on a Trello board",
  {
    boardId: z.string().describe("Board ID"),
    filter: z.enum(["all", "open", "closed"]).default("open").describe("List filter"),
  },
  async ({ boardId, filter }) => {
    const lists = await trelloFetch(`/boards/${boardId}/lists?filter=${filter}&fields=name,closed,pos`);
    return { content: [{ type: "text" as const, text: JSON.stringify(lists, null, 2) }] };
  }
);

server.tool(
  "get_cards",
  "Get cards on a board or list",
  {
    boardId: z.string().optional().describe("Board ID (use this OR listId)"),
    listId: z.string().optional().describe("List ID (use this OR boardId)"),
    filter: z.enum(["all", "open", "closed"]).default("open").describe("Card filter"),
  },
  async ({ boardId, listId, filter }) => {
    if (!boardId && !listId) throw new Error("Provide either boardId or listId");
    const path = listId
      ? `/lists/${listId}/cards?filter=${filter}`
      : `/boards/${boardId}/cards?filter=${filter}`;
    const cards = await trelloFetch(`${path}&fields=name,desc,url,shortUrl,closed,due,dueComplete,labels,idList,pos,dateLastActivity`);
    return { content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }] };
  }
);

server.tool(
  "get_card",
  "Get a single card by ID",
  { cardId: z.string().describe("Card ID") },
  async ({ cardId }) => {
    const card = await trelloFetch(`/cards/${cardId}?fields=name,desc,url,shortUrl,closed,due,dueComplete,labels,idList,pos,dateLastActivity&checklists=all`);
    return { content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }] };
  }
);

server.tool(
  "get_labels",
  "Get labels on a Trello board",
  { boardId: z.string().describe("Board ID") },
  async ({ boardId }) => {
    const labels = await trelloFetch(`/boards/${boardId}/labels?fields=name,color`);
    return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
  }
);

// --- Write tools ---

server.tool(
  "create_card",
  "Create a new card on a Trello list",
  {
    listId: z.string().describe("List ID to create the card in"),
    name: z.string().describe("Card title"),
    desc: z.string().optional().describe("Card description (markdown supported)"),
    due: z.string().optional().describe("Due date (ISO 8601)"),
    idLabels: z.array(z.string()).optional().describe("Label IDs to apply"),
    pos: z.union([z.literal("top"), z.literal("bottom"), z.number()]).optional().describe("Position: 'top', 'bottom', or a number"),
  },
  async ({ listId, name, desc, due, idLabels, pos }) => {
    const body: Record<string, unknown> = { idList: listId, name };
    if (desc) body["desc"] = desc;
    if (due) body["due"] = due;
    if (idLabels) body["idLabels"] = idLabels.join(",");
    if (pos !== undefined) body["pos"] = pos;
    const card = await trelloFetch("/cards", "POST", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }] };
  }
);

server.tool(
  "update_card",
  "Update an existing Trello card",
  {
    cardId: z.string().describe("Card ID"),
    name: z.string().optional().describe("New title"),
    desc: z.string().optional().describe("New description"),
    due: z.string().nullable().optional().describe("Due date (ISO 8601) or null to remove"),
    dueComplete: z.boolean().optional().describe("Mark due date as complete"),
    idList: z.string().optional().describe("Move to a different list"),
    idLabels: z.array(z.string()).optional().describe("Replace label IDs"),
    closed: z.boolean().optional().describe("Archive (true) or unarchive (false)"),
    pos: z.union([z.literal("top"), z.literal("bottom"), z.number()]).optional().describe("Position"),
  },
  async ({ cardId, ...updates }) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        body[k] = k === "idLabels" ? (v as string[]).join(",") : v;
      }
    }
    const card = await trelloFetch(`/cards/${cardId}`, "PUT", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }] };
  }
);

server.tool(
  "archive_card",
  "Archive (or unarchive) a Trello card",
  {
    cardId: z.string().describe("Card ID"),
    archive: z.boolean().default(true).describe("true to archive, false to unarchive"),
  },
  async ({ cardId, archive }) => {
    const card = await trelloFetch(`/cards/${cardId}`, "PUT", { closed: archive });
    return { content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }] };
  }
);

server.tool(
  "add_comment",
  "Add a comment to a Trello card",
  {
    cardId: z.string().describe("Card ID"),
    text: z.string().describe("Comment text"),
  },
  async ({ cardId, text }) => {
    const comment = await trelloFetch(`/cards/${cardId}/actions/comments`, "POST", { text });
    return { content: [{ type: "text" as const, text: JSON.stringify(comment, null, 2) }] };
  }
);

server.tool(
  "create_list",
  "Create a new list on a Trello board",
  {
    boardId: z.string().describe("Board ID"),
    name: z.string().describe("List name"),
    pos: z.union([z.literal("top"), z.literal("bottom"), z.number()]).optional().describe("Position"),
  },
  async ({ boardId, name, pos }) => {
    const body: Record<string, unknown> = { name, idBoard: boardId };
    if (pos !== undefined) body["pos"] = pos;
    const list = await trelloFetch("/lists", "POST", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
  }
);

// --- Checklist tools ---

server.tool(
  "add_checklist",
  "Add a checklist to a card",
  {
    cardId: z.string().describe("Card ID"),
    name: z.string().default("Checklist").describe("Checklist name"),
    items: z.array(z.string()).optional().describe("Checklist items to add"),
  },
  async ({ cardId, name, items }) => {
    const checklist = await trelloFetch(`/cards/${cardId}/checklists`, "POST", { name }) as { id: string };
    if (items?.length) {
      for (const item of items) {
        await trelloFetch(`/checklists/${checklist.id}/checkItems`, "POST", { name: item });
      }
    }
    const result = await trelloFetch(`/checklists/${checklist.id}?checkItems=all`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "search",
  "Search Trello for cards, boards, or members",
  {
    query: z.string().describe("Search query"),
    modelTypes: z.enum(["cards", "boards", "all"]).default("cards").describe("What to search for"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ query: q, modelTypes, limit }) => {
    const types = modelTypes === "all" ? "cards,boards" : modelTypes;
    const results = await trelloFetch(`/search?query=${encodeURIComponent(q)}&modelTypes=${types}&cards_limit=${limit}&boards_limit=${limit}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
