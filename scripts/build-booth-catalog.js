#!/usr/bin/env node

/**
 * Generate booth catalog JSON for batch QR generation.
 */

const fs = require("fs");
const path = require("path");

const INPUT_CSV = path.resolve(__dirname, "..", "booths.csv");
const OUTPUT_JSON = path.resolve(__dirname, "..", "assets", "booth_catalog.json");

const RANGES = [
  { prefix: "A", start: 1, end: 10 },
  { prefix: "B", start: 1, end: 10 },
  { prefix: "C", start: 1, end: 10 },
  { prefix: "D", start: 1, end: 10 },
  { prefix: "E", start: 1, end: 13 },
  { prefix: "F", start: 1, end: 12 },
  { prefix: "G", start: 1, end: 6 },
  { prefix: "H", start: 1, end: 5 },
  { prefix: "I", start: 1, end: 9 },
  { prefix: "J", start: 1, end: 5 },
  { prefix: "K", start: 1, end: 12 },
  { prefix: "L", start: 1, end: 15 }
];

function normalizeBoothId(rawId) {
  const value = (rawId || "").toString().trim().toUpperCase();
  if (!value) return "";
  const match = value.match(/^([A-Z])(\d{1,2})$/);
  if (match) {
    return `${match[1]}${match[2].padStart(2, "0")}`;
  }
  const digitsOnly = value.replace(/\D/g, "");
  return digitsOnly ? digitsOnly.padStart(3, "0") : "";
}

function readBoothMap() {
  if (!fs.existsSync(INPUT_CSV)) {
    throw new Error(`Missing booths.csv at ${INPUT_CSV}`);
  }
  const raw = fs.readFileSync(INPUT_CSV, "utf8");
  const lines = raw.trim().split(/\r?\n/).slice(1);
  const map = new Map();
  for (const line of lines) {
    if (!line) continue;
    const [/* menuId */, boothNumber, boothName] = line.split(",");
    if (!boothNumber) continue;
    const normalized = normalizeBoothId(boothNumber);
    if (!normalized) continue;
    map.set(normalized, (boothName || "").trim());
  }
  return map;
}

function buildCatalog() {
  const map = readBoothMap();
  const catalog = [];
  const missing = [];

  for (const { prefix, start, end } of RANGES) {
    for (let i = start; i <= end; i++) {
      const boothId = `${prefix}${String(i).padStart(2, "0")}`;
      const boothName = map.get(boothId) || "";
      if (!boothName) {
        missing.push(boothId);
      }
      catalog.push({ boothId, boothName });
    }
  }

  const json = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(OUTPUT_JSON, `${json}\n`, "utf8");

  if (missing.length) {
    console.warn(
      `Warning: ${missing.length} booth names missing in booths.csv: ${missing.join(
        ", "
      )}`
    );
  } else {
    console.log(`Catalog generated with ${catalog.length} entries.`);
  }

  return catalog.length;
}

try {
  const count = buildCatalog();
  if (count !== 117) {
    console.warn(`Expected 117 entries but found ${count}.`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

