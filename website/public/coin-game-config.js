// This file is the final migration switch. Set contractAddress and deploymentBlock
// only after the universal BurnFlip and Reward Vault pass the launch checklist.
window.MATT_COIN_FLIP_CONFIG = Object.freeze({
  chainId: 2020,
  version: "universal-v1",
  tokenAddress: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  contractAddress: "0x44BB8214b295e64Df8aac30097381C1Db4d66B31",
  deploymentBlock: 58950453,
  treasuryAddress: "0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc",
  explorerAddressBase: "https://explorer.roninchain.com/address/",
  burnEdition: true,
  assets: Object.freeze([
    Object.freeze({
      symbol: "RON",
      address: "0x0000000000000000000000000000000000000000",
      decimals: 18,
      native: true,
      enabled: true
    }),
    Object.freeze({
      symbol: "USDC",
      address: "0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc",
      decimals: 6,
      native: false,
      enabled: false,
      disabledReason: "USDC wagering is temporarily unavailable."
    }),
    Object.freeze({
      symbol: "WATER",
      address: "0x57A8Eb80d6813AEEEB9c8e770011C016F980d581",
      decimals: 18,
      native: false,
      enabled: true
    }),
    Object.freeze({
      symbol: "FIRE",
      address: "0x0E8Edc6f5CaC5dCaE036Ad77Fc0dE4E72404e2Fb",
      decimals: 18,
      native: false,
      enabled: true
    }),
    Object.freeze({
      symbol: "EARTH",
      address: "0xC89384CD2970c916DC75DA8e11524eBE6d77fa07",
      decimals: 18,
      native: false,
      enabled: true
    }),
    Object.freeze({
      symbol: "COIN",
      address: "0x7dc167e270d5EF683ceaf4aFCDf2efbDd667a9A7",
      decimals: 18,
      native: false,
      enabled: true
    }),
    Object.freeze({
      symbol: "RONKE",
      address: "0xf988f63bf26C3Ed3fBf39922149E3E7b1e5c27cB",
      decimals: 18,
      native: false,
      enabled: true
    }),
    Object.freeze({
      symbol: "NOTUS",
      address: "0x214b8ba88244587b69c609214e0b3e6cf56025d1",
      decimals: 18,
      native: false,
      enabled: false,
      disabledReason: "The MATT/NOTUS V3 pool currently has zero active liquidity."
    })
  ])
});
