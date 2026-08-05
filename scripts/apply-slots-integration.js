"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packagePath = path.join(root, "package.json");
const hubPath = path.join(root, "website/public/hub.html");
const requiredFiles = [
  "contracts/MattSlotsV1.sol",
  "contracts/MattSlotsRewardVault.sol",
  "contracts/MattSlotsTreasuryConverter.sol",
  "config/slots.math.v1.json",
  "website/public/slots.html",
  "website/public/slots.css",
  "website/public/slots.js",
  "website/public/slots-config.js",
  "website/public/slots-math-v1.js",
  "contracts/libraries/KatanaTwap.sol",
  "contracts/interfaces/IKatanaV3Pool.sol",
  "contracts/test/MockMattToken.sol",
  "contracts/test/MockRoninVRFCoordinator.sol"
];

function fail(message) {
  throw new Error(`Slots integration stopped: ${message}`);
}

function assertRepo() {
  if (!fs.existsSync(packagePath)) fail(`package.json was not found at ${packagePath}. Extract the build into the MATT repository root.`);
  if (!fs.existsSync(hubPath)) fail(`website/public/hub.html was not found at ${hubPath}.`);
  for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(root, relative))) fail(`required build file is missing: ${relative}`);
  }
}

function backupOnce(target) {
  const backup = `${target}.before-slots-v1`;
  if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  return backup;
}

function updatePackage() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.scripts ||= {};
  const scripts = {
    "test:slots": "hardhat test test/MattSlotsV1.test.js test/MattSlotsRewardVault.test.js test/MattSlotsTreasuryConverter.test.js && node --test website/lib/slots-math-v1.test.js website/lib/slots-page.test.js",
    "simulate:slots": "node scripts/simulate-slots-v1.js",
    "deploy:slots:saigon": "hardhat run scripts/deploy-slots.js --network saigon",
    "deploy:slots:ronin": "hardhat run scripts/deploy-slots.js --network ronin",
    "inspect:slots:saigon": "hardhat run scripts/inspect-slots.js --network saigon",
    "inspect:slots:ronin": "hardhat run scripts/inspect-slots.js --network ronin",
    "fund:slots-vault:saigon": "hardhat run scripts/fund-slots-vault.js --network saigon",
    "fund:slots-vault:ronin": "hardhat run scripts/fund-slots-vault.js --network ronin",
    "flush:slots-loss:saigon": "hardhat run scripts/flush-slots-loss.js --network saigon",
    "flush:slots-loss:ronin": "hardhat run scripts/flush-slots-loss.js --network ronin",
    "convert:slots-loss:saigon": "hardhat run scripts/convert-slots-loss.js --network saigon",
    "convert:slots-loss:ronin": "hardhat run scripts/convert-slots-loss.js --network ronin",
    "activate:slots:saigon": "hardhat run scripts/activate-slots.js --network saigon",
    "activate:slots:ronin": "hardhat run scripts/activate-slots.js --network ronin",
    "update:slots-frontend": "node scripts/update-slots-frontend.js"
  };
  Object.assign(packageJson.scripts, scripts);
  backupOnce(packagePath);
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return Object.keys(scripts);
}

function insertAfter(source, anchor, addition, label) {
  if (source.includes(addition)) return source;
  if (!source.includes(anchor)) fail(`could not find the ${label} insertion anchor in hub.html. The live Hub was left unchanged.`);
  return source.replace(anchor, `${anchor}${addition}`);
}

function updateHub() {
  let hub = fs.readFileSync(hubPath, "utf8");
  const navLink = '<a href="/slots">Slots</a>';
  const officialLink = '<a href="/slots"><span>MATT Slots</span><strong>Resource Rush · 5 reels · onchain spins</strong></a>';
  hub = insertAfter(hub, '<a href="/plinko-v4">Plinko</a>', navLink, "desktop navigation");
  hub = insertAfter(
    hub,
    '<a href="/plinko-v4"><span>Plinko V4</span><strong>Drop MATT coins at 98.2% RTP</strong></a>',
    officialLink,
    "official links"
  );
  backupOnce(hubPath);
  fs.writeFileSync(hubPath, hub);
}

function verify() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const hub = fs.readFileSync(hubPath, "utf8");
  if (!packageJson.scripts?.["test:slots"]) fail("package scripts were not written.");
  if (!hub.includes('href="/slots"')) fail("the Hub Slots link was not written.");
}

assertRepo();
const scripts = updatePackage();
updateHub();
verify();
console.log("MATT Slots V1 integration applied safely.");
console.log(`Added ${scripts.length} package scripts and linked /slots from MATT Hub.`);
console.log("Backups use the .before-slots-v1 suffix and are created only once.");
