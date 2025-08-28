import { ccc } from "@ckb-ccc/core";
import _ from "lodash";

export interface MultisigConfig {
  r: number;
  m: number;
  pubkeys: ccc.Bytes[];
  endpoints: string[];
}

export function parseMultisigConfig(o: any): MultisigConfig {
  const pubkeys = o.pubkeys.map((pubkey: ccc.BytesLike) => {
    const result = ccc.bytesFrom(pubkey);
    if (result.length !== 20) {
      throw new Error(`Invalid pubkey length: ${result.length}, expected 20!`);
    }
    return result;
  });
  if (pubkeys.length > 255) {
    throw new Error(
      `A maximum of 255 pubkeys are allowed, actual: ${pubkeys.length}`,
    );
  }
  const endpoints = o.endpoints.map((endpoint: any) => _.toString(endpoint));
  if (endpoints.length !== pubkeys.length) {
    throw new Error(
      `The number of endpoints must match the number of pubkeys: ${endpoints.length} !== ${pubkeys.length}`,
    );
  }
  const r = _.toNumber(o.r);
  if (_.isNaN(r) || r < 0 || r > pubkeys.length) {
    throw new Error(`Invalid r: ${r}`);
  }
  const m = _.toNumber(o.m);
  if (_.isNaN(m) || o <= 0 || o > pubkeys.length) {
    throw new Error(`Invalid m: ${m}`);
  }
  if (r > m) {
    throw new Error(`r(${r}) cannot be bigger than m(${m})!`);
  }
  return { r, m, pubkeys, endpoints };
}

// multisig_script is a customized data structure, it is not a CKB script!
//
// See the following link for details:
// https://github.com/nervosnetwork/ckb-system-scripts/blob/72eb92fca090700dcb398cd8cad8fbd8bad40355/c/secp256k1_blake160_multisig_all.c#L17
export function multisigScript(config: MultisigConfig): ccc.Bytes {
  const combined = new Uint8Array(4 + config.pubkeys.length * 20);
  combined.set([0, config.r, config.m, config.pubkeys.length]);
  for (let i = 0; i < config.pubkeys.length; i++) {
    combined.set(config.pubkeys[i], 4 + i * 20);
  }
  return combined;
}

export function multisigCkbScriptArgs(config: MultisigConfig): ccc.Hex {
  return ccc.hashCkb(multisigScript(config));
}

export async function multisigCkbScript(
  config: MultisigConfig,
  client: ccc.Client,
): Promise<ccc.Script> {
  return await ccc.Script.fromKnownScript(
    client,
    ccc.KnownScript.Secp256k1MultisigV2,
    multisigCkbScriptArgs(config),
  );
}

export function witnessLockPlaceholder(config: MultisigConfig) {
  const s = multisigScript(config);
  const combined = new Uint8Array(s.length + config.pubkeys.length * 65);
  combined.set(s);
  return combined;
}
