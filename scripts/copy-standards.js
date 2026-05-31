"use strict";

const fs = require("fs");
const path = require("path");

const sourceDir = path.join(__dirname, "..", "src", "standards");
const targetDir = path.join(__dirname, "..", "dist", "standards");

if (!fs.existsSync(sourceDir)) {
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  fs.unlinkSync(path.join(targetDir, entry.name));
}

for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const sourcePath = path.join(sourceDir, entry.name);
  const targetPath = path.join(targetDir, entry.name);

  fs.copyFileSync(sourcePath, targetPath);
}
