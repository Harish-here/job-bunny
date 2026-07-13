// scripts/notion/client.js — shared Notion client factory. One place for the
// dotenv load, the NOTION_TOKEN guard, and Client construction.
// init.js deliberately does NOT use this — it dynamic-imports @notionhq/client so a
// missing install fails with its friendly dependency preflight, not ERR_MODULE_NOT_FOUND.

import "dotenv/config";
import { Client } from "@notionhq/client";

export function requireToken(hint = "run /setup first") {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error(`NOTION_TOKEN missing — ${hint}.`);
  return token;
}

export function createClient(token = requireToken()) {
  return new Client({ auth: token });
}
