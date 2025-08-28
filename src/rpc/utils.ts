import { JSONRPC, JSONRPCID, JSONRPCParams } from "json-rpc-2.0";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import _ from "lodash";

export type Case = "camel" | "snake";

export interface Params {
  c: Case;
  tx: ccc.Transaction;
  others: any[];
}

export interface Result {
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export function buildParams(params?: JSONRPCParams): Params {
  let forceParamCase = null;
  if (!_.isArray(params)) {
    throw new Error("Params must be an array!");
  }
  if (params[params.length - 1] === "snake") {
    forceParamCase = "snake";
    params.pop();
  } else if (params[params.length - 1] === "camel") {
    forceParamCase = "camel";
    params.pop();
  }
  const txData = params.shift();
  if (!_.isObject(txData)) {
    throw new Error("The first element in params must be the tx object!");
  }
  const inputCase = _.has(txData, "outputs_data") ? "snake" : "camel";
  // TODO: validate input parameters
  const tx =
    inputCase === "snake"
      ? cccA.JsonRpcTransformers.transactionTo(txData as any)
      : ccc.Transaction.from(txData);
  const c = forceParamCase !== null ? (forceParamCase as Case) : inputCase;
  return {
    c,
    tx,
    others: params,
  };
}

export function buildTx(c: Case, tx: ccc.Transaction) {
  if (c === "camel") {
    return tx;
  } else {
    return cccA.JsonRpcTransformers.transactionFrom(tx);
  }
}

export function buildResponse(c: Case, result: Result, id: JSONRPCID | null) {
  const base = {
    jsonrpc: JSONRPC,
    id: id || null,
  };
  if (result.error !== undefined) {
    return Object.assign({}, base, {
      error: result.error,
    });
  } else {
    return Object.assign({}, base, {
      result: transformResultCase(c, result.result),
    });
  }
}

export function transformResultCase(c: Case, result?: any): any {
  if (c === "camel") {
    return snakeToCamel(result);
  } else {
    return camelToSnake(result);
  }
}

export function camelToSnake(obj: any) {
  return _.transform(obj, (result: any, value, key: string) => {
    const snakeKey = _.snakeCase(key);
    result[snakeKey] = _.isObject(value) ? camelToSnake(value) : value;
  });
}

export function snakeToCamel(obj: any) {
  return _.transform(obj, (result: any, value, key: string) => {
    const snakeKey = _.camelCase(key);
    result[snakeKey] = _.isObject(value) ? snakeToCamel(value) : value;
  });
}

export const ERROR_CODE_INVALID_INPUT = 2001;
export const ERROR_CODE_SERVER = 2002;
