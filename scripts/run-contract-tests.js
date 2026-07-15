const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const testDir = path.join(rootDir, "test");
const hardhatCli = require.resolve("hardhat/internal/cli/cli");
const files = fs.readdirSync(testDir)
  .filter(name => name.endsWith(".test.js"))
  .sort();

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [hardhatCli, "test", path.join("test", file)], {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    env: process.env,
    windowsHide: true,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\nAll ${files.length} contract test files passed in isolated Hardhat networks.`);
