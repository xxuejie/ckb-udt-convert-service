import { JSONRPCServer } from "json-rpc-2.0";
import { ccc } from "@ckb-ccc/core";

import {
  buildParams,
  buildTx,
  buildResponse,
  Params,
  Result,
  ERROR_CODE_INVALID_INPUT,
  ERROR_CODE_SERVER,
} from "../rpc/utils";

import { MultisigConfig, multisigCkbScript } from "./utils";

export interface RpcConfig {
  client: ccc.Client;
  signer: ccc.SignerCkbPrivateKey;
  config: MultisigConfig;
}

export function buildRpc(config: RpcConfig) {
  const sign = async (params: Params) => {
    const tx = params.tx;

    // TODO: validate transaction if needed

    const info = await tx.getSignHashInfo(
      await multisigCkbScript(config.config, config.client),
      config.client,
    );
    if (info === undefined) {
      return {
        error: {
          code: ERROR_CODE_INVALID_INPUT,
          message: "Cannot find fund pool script to sign!",
        },
      };
    }
    const signature = await config.signer._signMessage(info.message);

    return {
      result: { signature },
    };
  };

  const rpc = new JSONRPCServer();
  rpc.addMethodAdvanced("sign", async (request) => {
    const params = buildParams(request.params);
    return buildResponse(params.c, await sign(params), request.id || null);
  });
  return rpc;
}
