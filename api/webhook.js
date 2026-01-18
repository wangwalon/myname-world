import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------- Google Sheets helpers --------
function getSheetsClient() {
  if (!SA_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");

  const creds = JSON.parse(SA_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function findRowIndexBySessionId(sheets, sessionId) {
  const range = `${SHEET_NAME}!A:A`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i]?.[0] || "").trim() === sessionId) return i + 1;
  }
  return null;
}

async function getStatusByRow(sheets, rowIndex) {
  const range = `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return resp.data.values?.[0]?.[0] || "";
}

async function appendOrderRow(sheets, { sessionId, email, status, error = "" }) {
  const now = new Date().toISOString();
  const values = [[sessionId, email || "", status, now, now, error]];
  await sheets.
