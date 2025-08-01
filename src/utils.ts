import { ccc } from "@ckb-ccc/core";

import { udtArgs } from "./env";

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

export async function buildUdtScript(funder: ccc.Signer) {
  const udtScriptInfo = await funder.client.getKnownScript(
    ccc.KnownScript.XUdt,
  );
  return new ccc.Script(
    udtScriptInfo.codeHash,
    udtScriptInfo.hashType,
    udtArgs,
  );
}
