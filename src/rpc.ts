import { JSONRPC, JSONRPCID, JSONRPCServer, JSONRPCParams } from "json-rpc-2.0";
import { backOff } from "exponential-backoff";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import _ from "lodash";

import {
  dbConnection,
  funder,
  incentivePercent,
  lockedSeconds,
  maxTradedCkb,
  commitingSeconds,
  signerQueue,
  udtCellDeps,
  udtName,
  udtInfo,
  udtScript,
} from "./env";
import {
  buildKey,
  calculateBidUdts,
  cancelAllCommitingCells,
  env,
  epoch_timestamp,
  fetchFeeRate,
  txExternalKey,
  Logger,
  KEY_LIVE_CELLS,
  KEY_LOCKED_CELLS,
  KEY_COMMITING_CELLS,
  KEY_PENDING_TXS,
  KEY_PREFIX_TX,
  KEY_PREFIX_SIGNED_TX,
} from "./utils";

export const rpc = new JSONRPCServer();

rpc.addMethodAdvanced("initiate", async (request) => {
  const params = buildParams(request.params);
  return buildResponse(params.c, await initiate(params), request.id || null);
});

rpc.addMethodAdvanced("confirm", async (request) => {
  const params = buildParams(request.params);
  return buildResponse(params.c, await confirm(params), request.id || null);
});

type Case = "camel" | "snake";

interface Params {
  c: Case;
  tx: ccc.Transaction;
  others: any[];
}

interface Result {
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function buildParams(params?: JSONRPCParams): Params {
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

function buildTx(c: Case, tx: ccc.Transaction) {
  if (c === "camel") {
    return tx;
  } else {
    return cccA.JsonRpcTransformers.transactionFrom(tx);
  }
}

function buildResponse(c: Case, result: Result, id: JSONRPCID | null) {
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

function transformResultCase(c: Case, result?: any): any {
  if (c === "camel") {
    return snakeToCamel(result);
  } else {
    return camelToSnake(result);
  }
}

function camelToSnake(obj: any) {
  return _.transform(obj, (result: any, value, key: string) => {
    const snakeKey = _.snakeCase(key);
    result[snakeKey] = _.isObject(value) ? camelToSnake(value) : value;
  });
}

function snakeToCamel(obj: any) {
  return _.transform(obj, (result: any, value, key: string) => {
    const snakeKey = _.camelCase(key);
    result[snakeKey] = _.isObject(value) ? snakeToCamel(value) : value;
  });
}

const ERROR_CODE_INVALID_INPUT = 2001;
const ERROR_CODE_SERVER = 2002;

async function initiate(params: Params): Promise<Result> {
  let tx = params.tx;

  const currentTimestamp = epoch_timestamp();
  const expiredTimestamp = (
    parseInt(currentTimestamp) + lockedSeconds
  ).toString();

  {
    const funderScript = (await funder.getAddressObjSecp256k1()).script;
    const collectingScript = (
      await ccc.Address.fromString(
        env("COLLECTING_POOL_ADDRESS"),
        funder.client,
      )
    ).script;

    for (const input of tx.inputs) {
      const cell = await input.getCell(funder.client);
      if (
        cell.cellOutput.lock.eq(funderScript) ||
        cell.cellOutput.lock.eq(collectingScript)
      ) {
        return {
          error: {
            code: ERROR_CODE_INVALID_INPUT,
            message: "Input cells uses invalid lock script!",
          },
        };
      }
    }
  }

  const inputCapacity = await tx.getInputsCapacity(funder.client);
  const outputCapacity = tx.getOutputsCapacity();
  if (inputCapacity >= outputCapacity) {
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message: "Input ckbytes are enough for output ckbytes!",
      },
    };
  }
  const bidTokensNoFee = outputCapacity - inputCapacity;

  const priceStr = await dbConnection.get(`PRICE:${udtName}`);
  if (priceStr === null || priceStr === undefined) {
    return {
      error: {
        code: ERROR_CODE_SERVER,
        message: `${udtInfo.human} price unknown!`,
      },
    };
  }
  const udtPricePerCkb = ccc.fixedPointFrom(priceStr, 6);

  const indices = params.others[0];
  for (const i of indices) {
    if (i < 0 || i >= tx.outputs.length || !tx.outputs[i].type?.eq(udtScript)) {
      return {
        error: {
          code: ERROR_CODE_SERVER,
          message: `Invalid indices!`,
        },
      };
    }
  }
  const availableUdtBalance = tx.outputsData.reduce((acc, data, i) => {
    if (!indices.includes(i)) {
      return acc;
    }
    return acc + ccc.udtBalanceFrom(data);
  }, ccc.numFrom(0));

  // The estimation here is that the user should always be available to
  // trade one more CKBytes, so as to cover for fees. The actual charged
  // fees will be calculated below and are typically much less than 1 CKB.
  const MAXIMUM_FEE = ccc.fixedPointFrom("1");
  const requestedCapacity = bidTokensNoFee + MAXIMUM_FEE;
  const estimateAskTokens = calculateBidUdts(
    udtPricePerCkb,
    incentivePercent,
    requestedCapacity,
  );
  if (availableUdtBalance <= estimateAskTokens) {
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message: `At least ${estimateAskTokens} UDT tokens must be available to convert to CKB!`,
      },
    };
  }

  let availableCapacity = 0n;
  // Lock one or more cells to provide ckbytes for current tx
  const capacityCellStartIndex = tx.outputs.length;
  let locked = false;
  while (availableCapacity < requestedCapacity) {
    const outPointBytes = await (dbConnection as any).lockCell(
      KEY_LIVE_CELLS,
      KEY_LOCKED_CELLS,
      KEY_COMMITING_CELLS,
      currentTimestamp,
      expiredTimestamp,
    );
    if (!outPointBytes) {
      return {
        error: {
          code: ERROR_CODE_SERVER,
          message: "No live cell is available for converting!",
        },
      };
    }
    const outPoint = ccc.OutPoint.fromBytes(outPointBytes);
    const cell = await funder.client.getCellLive(outPoint, true);
    if (cell === null || cell === undefined) {
      return {
        error: {
          code: ERROR_CODE_SERVER,
          message: "Server data mismatch!",
        },
      };
    }

    tx.inputs.push(
      ccc.CellInput.from({
        previousOutput: outPoint,
      }),
    );
    // We will do the actual CKB / UDT manipulation later when we can calculate the fee
    tx.outputs.push(cell.cellOutput);
    tx.outputsData.push(cell.outputData);

    // We will keep the first locked cell, all locked cells after the first can be
    // destructed.
    if (locked) {
      availableCapacity += cell.cellOutput.capacity;
    } else {
      availableCapacity += cell.capacityFree;
    }
    locked = true;
  }
  tx = await funder.prepareTransaction(tx);
  tx.addCellDeps(udtCellDeps);

  // Calculate the fee to build final ask / bid tokens
  const feeRate = await fetchFeeRate(funder.client);
  const fee = tx.estimateFee(feeRate);

  const bidTokens = bidTokensNoFee + fee;
  const askTokens = calculateBidUdts(
    udtPricePerCkb,
    incentivePercent,
    bidTokens,
  );
  if (bidTokens > maxTradedCkb) {
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message: `You are trading too many CKBytes in one transaction!`,
      },
    };
  }

  // Modify locked cells to charge +bidTokens+ CKBytes, collect +askTokens+ UDTs
  {
    tx.outputsData[capacityCellStartIndex] = ccc.hexFrom(
      ccc.numLeToBytes(
        ccc.udtBalanceFrom(tx.outputsData[capacityCellStartIndex]) + askTokens,
        16,
      ),
    );
    // The first output cell needs to be kept so as to collect UDTs
    let charged = 0n;
    {
      const cell = ccc.Cell.from({
        previousOutput: ccc.OutPoint.from({
          txHash: tx.hash(),
          index: capacityCellStartIndex,
        }),
        cellOutput: tx.outputs[capacityCellStartIndex],
        outputData: tx.outputsData[capacityCellStartIndex],
      });
      charged = cell.capacityFree;
      if (charged > bidTokens) {
        charged = bidTokens;
      }
      tx.outputs[capacityCellStartIndex].capacity -= charged;
    }

    for (
      let i = capacityCellStartIndex + 1;
      i < tx.outputs.length && charged < bidTokens;
      i++
    ) {
      const cell = ccc.Cell.from({
        previousOutput: ccc.OutPoint.from({
          txHash: tx.hash(),
          index: i,
        }),
        cellOutput: tx.outputs[i],
        outputData: tx.outputsData[i],
      });

      let currentCharged = bidTokens - charged;
      if (currentCharged > cell.cellOutput.capacity) {
        // Consumes full output cell, we need to move UDTs if there are any
        currentCharged = cell.cellOutput.capacity;
        tx.outputsData[capacityCellStartIndex] = ccc.hexFrom(
          ccc.numLeToBytes(
            ccc.udtBalanceFrom(tx.outputsData[capacityCellStartIndex]) +
              ccc.udtBalanceFrom(tx.outputsData[i]),
            16,
          ),
        );
        tx.outputs.splice(i, 1);
        tx.outputsData.splice(i, 1);
        i--;
      } else if (currentCharged > cell.capacityFree) {
        // Consumes output cell, but there are left over CKBytes that are not enough for a cell
        tx.outputsData[capacityCellStartIndex] = ccc.hexFrom(
          ccc.numLeToBytes(
            ccc.udtBalanceFrom(tx.outputsData[capacityCellStartIndex]) +
              ccc.udtBalanceFrom(tx.outputsData[i]),
            16,
          ),
        );
        tx.outputs[capacityCellStartIndex].capacity +=
          cell.cellOutput.capacity - currentCharged;
        tx.outputs.splice(i, 1);
        tx.outputsData.splice(i, 1);
        i--;
      } else {
        // Consumes free CKBytes of output cell
        tx.outputs[i].capacity -= currentCharged;
      }
      charged += currentCharged;
    }
    if (charged < bidTokens) {
      return {
        error: {
          code: ERROR_CODE_SERVER,
          message: `At least ${bidTokens} CKBytes must be available!`,
        },
      };
    }
  }

  // Charge +askTokens+ UDTs from output cells indices by +indices+
  {
    let charged = 0n;
    for (const i of indices) {
      if (charged >= askTokens) {
        break;
      }
      const available = ccc.udtBalanceFrom(tx.outputsData[i]);
      let currentCharged = askTokens - charged;
      if (currentCharged > available) {
        currentCharged = available;
      }
      const left = available - currentCharged;
      tx.outputsData[i] = ccc.hexFrom(ccc.numLeToBytes(left, 16));
      charged += currentCharged;
    }
    if (charged < askTokens) {
      return {
        error: {
          code: ERROR_CODE_INVALID_INPUT,
          message: `At least ${askTokens} UDT tokens must be available to convert to CKB!`,
        },
      };
    }
  }

  // A larger EX value is safer, and won't cost us too much here.
  await dbConnection.setex(
    buildKey(KEY_PREFIX_TX, txExternalKey(tx)),
    lockedSeconds * 2,
    ccc.hexFrom(tx.toBytes()),
  );

  return {
    result: {
      valid_until: new Date(parseInt(expiredTimestamp) * 1000).toISOString(),
      transaction: buildTx(params.c, tx),
      ask_tokens: askTokens,
      bid_tokens: bidTokens,
    },
  };
}

async function confirm(params: Params): Promise<Result> {
  let tx = params.tx;
  if (tx.inputs.length === 0) {
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message: "Transaction has no inputs!",
      },
    };
  }

  const currentTimestamp = epoch_timestamp();
  const expiredTimestamp = (
    parseInt(currentTimestamp) + commitingSeconds
  ).toString();

  const keyBytes = txExternalKey(tx);
  const txKey = buildKey(KEY_PREFIX_TX, keyBytes);
  const savedTxBytes = await dbConnection.get(txKey);

  const INVALID_CELL_ERROR = {
    error: {
      code: ERROR_CODE_INVALID_INPUT,
      message: "Locked cell is missing, invalid or expired!",
    },
  };
  if (savedTxBytes === null || savedTxBytes === undefined) {
    return INVALID_CELL_ERROR;
  }
  try {
    const savedTx = ccc.Transaction.fromBytes(savedTxBytes);
    if (!(await compareTx(tx, savedTx))) {
      Logger.error(`User provided a modified tx for ${savedTx.hash()}`);
      return INVALID_CELL_ERROR;
    }
  } catch (e) {
    Logger.error(`Parsing saved tx error: ${e}`);
    return INVALID_CELL_ERROR;
  }

  {
    // Commit all funder cells
    const funderScript = (await funder.getAddressObjSecp256k1()).script;

    for (const input of tx.inputs) {
      const inputCell = await input.getCell(funder.client);
      if (inputCell.cellOutput.lock.eq(funderScript)) {
        const commitResult = await (dbConnection as any).commitCell(
          KEY_LIVE_CELLS,
          KEY_LOCKED_CELLS,
          KEY_COMMITING_CELLS,
          txKey,
          ccc.hexFrom(input.previousOutput.toBytes()),
          currentTimestamp,
          expiredTimestamp,
        );
        if (!commitResult) {
          return INVALID_CELL_ERROR;
        }
      }
    }
  }

  const signedTxKey = buildKey(KEY_PREFIX_SIGNED_TX, keyBytes);
  await signerQueue.add("sign", {
    tx: ccc.hexFrom(tx.toBytes()),
    targetKey: signedTxKey,
    ex: commitingSeconds * 2,
  });

  await backOff(async () => {
    if ((await dbConnection.exists(signedTxKey)) < 1) {
      throw new Error("wait!");
    }
  });

  const signedTx = ccc.Transaction.fromBytes(
    (await dbConnection.get(signedTxKey))!,
  );

  try {
    const txHash = await funder.client.sendTransaction(signedTx);
    Logger.info(`Tx ${txHash} submitted to CKB!`);
  } catch (e) {
    const message = `Sending transaction ${signedTx.hash()} receives errors: ${e}`;
    Logger.error(message);
    await cancelAllCommitingCells(signedTx, funder, dbConnection);

    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message,
      },
    };
  }
  await dbConnection.rpush(KEY_PENDING_TXS, ccc.hexFrom(signedTx.toBytes()));

  return {
    result: {
      transaction: buildTx(params.c, signedTx),
    },
  };
}

// Only witnesses belonging to users can be tweaked(mainly for signatures)
async function compareTx(
  tx: ccc.Transaction,
  savedTx: ccc.Transaction,
): Promise<boolean> {
  if (
    tx.hash() !== savedTx.hash() ||
    tx.witnesses.length !== savedTx.witnesses.length
  ) {
    return false;
  }

  const funderScript = (await funder.getAddressObjSecp256k1()).script;
  for (let i = 0; i < tx.witnesses.length; i++) {
    const inputCell = await tx.inputs[i].getCell(funder.client);
    if (inputCell.cellOutput.lock.eq(funderScript)) {
      if (tx.witnesses[i].length !== savedTx.witnesses[i].length) {
        return false;
      }
    }
  }
  return true;
}
