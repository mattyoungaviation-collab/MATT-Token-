"use strict";

const math = require("../website/lib/slots-math-v1");

const iterations = Number.parseInt(process.argv[2] || process.env.SLOTS_SIM_SPINS || "1000000", 10);
if (!Number.isSafeInteger(iterations) || iterations < 10_000) {
  throw new Error("Run at least 10,000 simulated paid spins.");
}
const result = math.simulate(iterations, 0x4d415454);
const percent = value => `${(value * 100).toFixed(4)}%`;

console.log(JSON.stringify({
  ...result,
  rtpPercent: percent(result.rtp),
  paidLineRtpPercent: percent(result.paidLineRtp),
  paidScatterRtpPercent: percent(result.paidScatterRtp),
  baseRtpPercent: percent(result.baseRtp),
  bonusRtpPercent: percent(result.bonusRtp),
  anyReturnPercent: percent(result.anyReturnRate),
  paidSpinNetWinPercent: percent(result.paidSpinNetWinRate),
  bonusTriggerPercent: percent(result.bonusTriggerRate),
  bucketPercents: Object.fromEntries(
    Object.entries(result.buckets).map(([key, value]) => [key, percent(value)])
  )
}, null, 2));

// This is a regression band, not the final independent math certification.
if (result.rtp < 0.94 || result.rtp > 1.00) {
  throw new Error(`Slots V1 simulated RTP ${percent(result.rtp)} left the safe 94–100% staging band.`);
}
