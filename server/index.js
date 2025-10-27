#!/usr/bin/env node

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

const app = express();

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const DRIVE_FOLDER_LINK =
  process.env.DRIVE_FOLDER_LINK ||
  (DRIVE_FOLDER_ID
    ? `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`
    : "");
const PORT = process.env.PORT || 3000;

if (!DRIVE_FOLDER_ID) {
  console.warn(
    "[batch] DRIVE_FOLDER_ID is not set. Upload endpoint will return an error."
  );
}

app.use(cors());
app.use(
  bodyParser.json({
    limit: process.env.BATCH_UPLOAD_LIMIT || "20mb"
  })
);

const STATIC_ROOT = path.resolve(__dirname, "..");
app.use(express.static(STATIC_ROOT, { extensions: ["html"] }));

let driveClientPromise = null;

async function getDriveClient() {
  if (driveClientPromise) return driveClientPromise;
  driveClientPromise = (async () => {
    const scopes = [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.appdata"
    ];
    const auth = new google.auth.GoogleAuth({ scopes });
    const client = await auth.getClient();
    return google.drive({ version: "v3", auth: client });
  })();
  return driveClientPromise;
}

function dataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== "string") {
    throw new Error("imageData must be a string");
  }
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported image data format");
  }
  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");
  return { buffer, mimeType };
}

async function findExistingFile(drive, boothId) {
  const queryParts = [
    `'${DRIVE_FOLDER_ID}' in parents`,
    "trashed = false",
    `appProperties has { key='boothId' and value='${boothId}' }`
  ];
  const response = await drive.files.list({
    q: queryParts.join(" and "),
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: false
  });
  return (response.data.files && response.data.files[0]) || null;
}

async function uploadSingle(drive, item, batchId) {
  if (!item || !item.boothId || !item.imageData) {
    throw new Error("Invalid upload item");
  }
  const { buffer, mimeType } = dataUrlToBuffer(item.imageData);
  const existing = await findExistingFile(drive, item.boothId);
  const metadata = {
    name: item.fileName || `${item.boothId}.png`,
    parents: [DRIVE_FOLDER_ID],
    appProperties: {
      boothId: item.boothId,
      boothName: item.boothName || "",
      batchId: batchId || ""
    }
  };
  const media = {
    mimeType: mimeType || "image/png",
    body: Readable.from(buffer)
  };
  const fields = "id, name, webViewLink";
  const requestBody = {
    requestBody: metadata,
    media,
    fields,
    supportsAllDrives: false
  };
  const response = existing
    ? await drive.files.update({ fileId: existing.id, ...requestBody })
    : await drive.files.create(requestBody);
  return response.data;
}

app.post("/api/batch-upload", async (req, res) => {
  if (!DRIVE_FOLDER_ID) {
    return res.status(500).json({
      error: { code: "DRIVE_NOT_CONFIGURED", message: "Drive folder is not configured." }
    });
  }
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res
      .status(400)
      .json({ error: { code: "INVALID_REQUEST", message: "`items` must be a non-empty array." } });
  }
  const batchId = req.body.batchId || "";
  try {
    const drive = await getDriveClient();
    const results = [];
    for (const item of items) {
      try {
        const file = await uploadSingle(drive, item, batchId);
        results.push({
          boothId: item.boothId,
          status: "success",
          fileId: file.id,
          webViewLink: file.webViewLink || DRIVE_FOLDER_LINK
        });
      } catch (error) {
        console.error("[batch] Upload failed", error);
        results.push({
          boothId: item && item.boothId ? item.boothId : "UNKNOWN",
          status: "failed",
          errorMessage: error.message || "Upload failed"
        });
      }
    }
    res.json({
      results,
      folderLink: DRIVE_FOLDER_LINK || null
    });
  } catch (error) {
    console.error("[batch] Fatal error", error);
    res.status(500).json({
      error: { code: "UPLOAD_FAILED", message: error.message || "Upload failed" }
    });
  }
});

app.get("*", (req, res, next) => {
  const indexPath = path.join(STATIC_ROOT, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`[batch] Server is running on http://localhost:${PORT}`);
});

