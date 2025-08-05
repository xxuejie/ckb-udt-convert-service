import pino from "pino";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import fs from "fs";

export const Logger = pino();

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

export function buildKey(prefix: ccc.BytesLike, content: ccc.BytesLike) {
  return Buffer.from(ccc.bytesConcat(prefix, content));
}

export async function buildUdtScript(funder: ccc.Signer, args: ccc.Hex) {
  const udtScriptInfo = await funder.client.getKnownScript(
    ccc.KnownScript.XUdt,
  );
  return new ccc.Script(udtScriptInfo.codeHash, udtScriptInfo.hashType, args);
}
