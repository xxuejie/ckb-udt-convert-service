import { ccc } from "@ckb-ccc/core";
import _ from "lodash";

import { SignerCkbMultisig } from "../ccc";
import { buildJsonRpcClient } from "../jsonrpc";
import { buildTx } from "../rpc/utils";
import { Logger } from "../utils";

export interface MultisigConfig {
  r: number;
  m: number;
  pubkeys: ccc.Hex[];
  endpoints: string[];
}

export function parseMultisigConfig(o: any): MultisigConfig {
  const pubkeys = o.pubkeys.map((pubkey: ccc.BytesLike) => {
    const result = ccc.bytesFrom(pubkey);
    if (result.length !== 20) {
      throw new Error(`Invalid pubkey length: ${result.length}, expected 20!`);
    }
    return ccc.hexFrom(result);
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
  if (_.isNaN(m) || m <= 0 || m > pubkeys.length) {
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
    combined.set(ccc.bytesFrom(config.pubkeys[i]), 4 + i * 20);
  }
  return combined;
}

export function multisigCkbScriptArgs(config: MultisigConfig): ccc.Hex {
  return ccc.hexFrom(
    ccc.bytesFrom(ccc.hashCkb(multisigScript(config))).slice(0, 20),
  );
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
  const combined = new Uint8Array(s.length + config.m * 65);
  combined.set(s);
  return combined;
}

export async function signMultisigTx(
  tx: ccc.Transaction,
  funder: SignerCkbMultisig,
): Promise<ccc.Transaction> {
  const config = funder.config;
  // Preliminary check
  const position = await tx.findInputIndexByLock(
    (await funder.getRecommendedAddressObj()).script,
    funder.client,
  );
  if (position === undefined) {
    throw new Error("Multisig lock is not used in transaction!");
  }
  const witness = tx.getWitnessArgsAt(position);
  if (witness === undefined) {
    throw new Error("Required witness is missing!");
  }
  const lockBytes = ccc.bytesFrom(witness.lock || "0x");
  if (!_.isEqual(lockBytes, witnessLockPlaceholder(config))) {
    throw new Error("Invalid witness structure for multisig!");
  }

  // Actual signing
  const signatures = [];
  if (config.r > 0) {
    // Required signatures
    try {
      const responses = await Promise.all(
        config.endpoints.slice(0, config.r).map((endpoint) => {
          return buildJsonRpcClient(endpoint).request("sign", [
            buildTx("snake", tx),
          ]);
        }),
      );
      for (const { signature } of responses) {
        signatures.push(signature);
      }
    } catch (e) {
      Logger.error("Multisig RPC error: ", e);
      throw new Error("Error occurs contacting multisig server!");
    }
  }
  if (config.m > config.r) {
    // Non-required signatures
    const responses = await Promise.allSettled(
      config.endpoints.slice(config.r).map((endpoint) => {
        return buildJsonRpcClient(endpoint).request("sign", [
          buildTx("snake", tx),
        ]);
      }),
    );
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      if (response.status === "rejected") {
        Logger.info(
          `Multisig endpoint ${config.r + i} encounters error:`,
          response.reason,
        );
        continue;
      }
      signatures.push(response.value.signature);
      if (signatures.length >= config.m) {
        break;
      }
    }
  }
  if (signatures.length < config.m) {
    Logger.error(
      `Multiple multisig server failed, required: ${config.m}, active: ${signatures.length}`,
    );
    throw new Error("Cannot gather enough signatures!");
  }

  // Fill in signatures
  const startOffset = multisigScript(config).length;
  for (let i = 0; i < config.m; i++) {
    lockBytes.set(ccc.bytesFrom(signatures[i]), startOffset + i * 65);
  }
  witness.lock = ccc.hexFrom(lockBytes);
  tx.setWitnessArgsAt(position, witness);

  return tx;
}
