import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import fs from "fs";

import {
  MultisigConfig,
  multisigCkbScriptArgs,
  witnessLockPlaceholder,
} from "./multisig/utils";

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

export class SignerCkbMultisig extends ccc.Signer {
  constructor(client: ccc.Client, config: MultisigConfig) {
    super(client);

    this.config = config;
  }

  get type(): ccc.SignerType {
    return ccc.SignerType.CKB;
  }

  get signType(): ccc.SignerSignType {
    return ccc.SignerSignType.Unknown;
  }

  async connect(): Promise<void> {}

  async isConnected(): Promise<boolean> {
    return true;
  }

  async getInternalAddress(): Promise<string> {
    return this.getRecommendedAddress();
  }

  async getAddressObjs(): Promise<ccc.Address[]> {
    return [await this.getAddressObjSecp256k1()];
  }

  public readonly config: MultisigConfig;

  async getAddressObjSecp256k1(): Promise<ccc.Address> {
    return ccc.Address.fromKnownScript(
      this.client,
      ccc.KnownScript.Secp256k1MultisigV2,
      multisigCkbScriptArgs(this.config),
    );
  }

  async prepareTransaction(
    txLike: ccc.TransactionLike,
  ): Promise<ccc.Transaction> {
    const tx = ccc.Transaction.from(txLike);
    const script = (await this.getAddressObjSecp256k1()).script;
    const cellDeps = (
      await this.client.getKnownScript(ccc.KnownScript.Secp256k1MultisigV2)
    ).cellDeps;

    const position = await tx.findInputIndexByLock(script, this.client);
    if (position !== undefined) {
      // Populate the first witness with placeholder data
      const witness = tx.getWitnessArgsAt(position) ?? ccc.WitnessArgs.from({});
      witness.lock = ccc.hexFrom(witnessLockPlaceholder(this.config));
      tx.setWitnessArgsAt(position, witness);
    }
    await tx.addCellDepInfos(this.client, cellDeps);

    return tx;
  }
}
