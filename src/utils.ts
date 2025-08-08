import pino from "pino";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import fs from "fs";
import util from "util";

const pinoLogger = pino();

export const Logger = {
  pino: pinoLogger,
  debug: (...args: any[]) => {
    pinoLogger.debug(util.format(...args));
  },
  info: (...args: any[]) => {
    pinoLogger.info(util.format(...args));
  },
  error: (...args: any[]) => {
    pinoLogger.error(util.format(...args));
  },
  warn: (...args: any[]) => {
    pinoLogger.warn(util.format(...args));
  },
};

process.on("unhandledRejection", (reason, promise) => {
  Logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

function assertIsDefined<T>(value: T | undefined | null, message?: string): T {
  if (value === undefined || value === null) {
    throw new Error(message || "Value cannot be undefined or null.");
  }
  return value;
}

export function env(value: string): string {
  return assertIsDefined(
    process.env[value],
    `${value} is not set in .env file!`,
  );
}

// We will use this till we figure out the details of ccc's cache
export class NoCache extends ccc.ClientCache {
  async markUsableNoCache(
    ...cellLikes: (ccc.CellLike | ccc.CellLike[])[]
  ): Promise<void> {}

  async markUnusable(
    ...outPointLikes: (ccc.OutPointLike | ccc.OutPointLike[])[]
  ): Promise<void> {}

  async clear(): Promise<void> {}

  async *findCells(
    keyLike: cccA.ClientCollectableSearchKeyLike,
  ): AsyncGenerator<ccc.Cell> {}

  async isUnusable(outPointLike: ccc.OutPointLike): Promise<boolean> {
    return false;
  }
}

export function buildNoCacheClient(
  network: string,
  url: string,
  scriptConfigFile: string,
) {
  switch (network) {
    case "mainnet":
      return new ccc.ClientPublicMainnet({
        url,
        cache: new NoCache(),
      });
    case "testnet":
      return new ccc.ClientPublicTestnet({
        url,
        cache: new NoCache(),
      });
    case "devnet":
      return new ccc.ClientPublicTestnet({
        url,
        scripts: JSON.parse(fs.readFileSync(scriptConfigFile, "utf8")),
        fallbacks: [],
        cache: new NoCache(),
      });
    default:
      throw new Error(`Unknown network value: ${network}`);
  }
}

export function epoch_timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export const KEY_LIVE_CELLS = "LIVE_CELLS";
export const KEY_LOCKED_CELLS = "LOCKED_CELLS";
export const KEY_COMMITING_CELLS = "COMMITING_CELLS";

export const KEY_PREFIX_CKB_CELLS = "_CKB_CELLS:";
export const KEY_PREFIX_CELL = "CELL:";
export const KEY_PREFIX_TX = "TX:";
export const KEY_PREFIX_SIGNED_TX = "SIGNED_TX:";

export function buildKey(prefix: string, content: ccc.BytesLike) {
  return prefix + ccc.hexFrom(content);
}

export async function fetchFeeRate(client: ccc.Client) {
  try {
    return (await client.getFeeRateStatistics())?.median;
  } catch (e) {
    const rate = process.env["DEFAULT_FEE_RATE"];
    if (rate === null || rate === undefined) {
      return cccA.DEFAULT_MIN_FEE_RATE;
    } else {
      return parseInt(rate);
    }
  }
}

import { fpFromDecimal } from "@hastom/fixed-point";

// As of right now, ccc's FixedPoint uses a single bigint to represent
// both the base and precision part. While adding / substracting works,
// multiplication will not work in this case. We will have to rely on
// another library for the task.
export function calculateBidUdts(
  udtPricePerCkb: ccc.FixedPoint,
  incentivePercent: string,
  ckbytes: ccc.FixedPoint,
) {
  const incentive = fpFromDecimal(incentivePercent, 6).add(
    fpFromDecimal("1", 6),
  );
  const updatedPrice = fpFromDecimal(
    ccc.fixedPointToString(udtPricePerCkb, 6),
    6,
  ).mul(incentive);

  const normalizedCkbytes = fpFromDecimal(
    ccc.fixedPointToString(ckbytes, 8),
    8,
  );
  const bidUdts = normalizedCkbytes.mul(updatedPrice);

  return ccc.fixedPointFrom(bidUdts.toDecimalString(), 6);
}
