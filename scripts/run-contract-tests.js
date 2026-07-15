const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const testDir = path.join(__dirname, "..", "test");
const files = fs.readdirSync(testDir)
  .filter(name => name.endsWith(".test.js"))
  .sort();

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const hardhatBin = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(hardhatBin, ["hardhat", "test", path.join("test", file)], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\nAll ${files.length} contract test files passed in isolated Hardhat networks.`);
