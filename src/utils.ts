import pino from "pino";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import IORedis from "ioredis";

import util from "util";

import { buildNoCacheClient } from "./ccc";

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
  // process.exit(1);
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

export function epoch_timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export const KEY_LIVE_CELLS = "LIVE_CELLS";
export const KEY_LOCKED_CELLS = "LOCKED_CELLS";
export const KEY_COMMITING_CELLS = "COMMITING_CELLS";
export const KEY_PENDING_TXS = "PENDING_TXS";

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

export function txExternalKey(tx: ccc.Transaction): ccc.Hex {
  return ccc.hexFrom(tx.inputs[tx.inputs.length - 1].previousOutput.toBytes());
}

export async function cancelAllCommitingCells(
  tx: ccc.Transaction,
  funder: ccc.Signer,
  dbConnection: IORedis,
) {
  const keyCellBytes = txExternalKey(tx);
  const txKey = buildKey(KEY_PREFIX_TX, keyCellBytes);
  const signedTxKey = buildKey(KEY_PREFIX_SIGNED_TX, keyCellBytes);
  const funderScript = (await funder.getRecommendedAddressObj()).script;

  for (const input of tx.inputs) {
    const inputCell = await input.getCell(funder.client);
    if (inputCell.cellOutput.lock.eq(funderScript)) {
      await (dbConnection as any).cancelCell(
        KEY_LOCKED_CELLS,
        KEY_COMMITING_CELLS,
        txKey,
        signedTxKey,
        ccc.hexFrom(input.previousOutput.toBytes()),
      );
    }
  }
}

export function buildCccClient() {
  return buildNoCacheClient(
    env("CKB_NETWORK"),
    env("CKB_RPC_URL"),
    env("SCRIPT_CONFIG_FILE"),
  );
}
