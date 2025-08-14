import { JSONRPC, JSONRPCID, JSONRPCServer } from "json-rpc-2.0";
import { backOff } from "exponential-backoff";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import {
  dbConnection,
  funder,
  incentivePercent,
  lockedSeconds,
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
  env,
  epoch_timestamp,
  fetchFeeRate,
  Logger,
  KEY_LIVE_CELLS,
  KEY_LOCKED_CELLS,
  KEY_COMMITING_CELLS,
  KEY_PREFIX_TX,
  KEY_PREFIX_SIGNED_TX,
} from "./utils";

export const rpc = new JSONRPCServer();

rpc.addMethodAdvanced("initiate", async (request) => {
  return buildResponse(await initiate(request.params), request);
});

rpc.addMethodAdvanced("confirm", async (request) => {
  return buildResponse(await confirm(request.params), request);
});

interface Result {
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function buildResponse(result: Result, request: { id?: JSONRPCID }) {
  const base = {
    jsonrpc: JSONRPC,
    id: request.id || null,
  };
  if (result.error !== undefined) {
    return Object.assign({}, base, {
      error: result.error,
    });
  } else {
    return Object.assign({}, base, {
      result: result.result,
    });
  }
}

const ERROR_CODE_INVALID_INPUT = 2001;
const ERROR_CODE_SERVER = 2002;

async function initiate(params: any): Promise<Result> {
  // TODO: validate input parameters
  let tx = ccc.Transaction.from(params[0]);

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

  const indices = params[1];
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
  const estimateAskTokens = calculateBidUdts(
    udtPricePerCkb,
    incentivePercent,
    bidTokensNoFee + MAXIMUM_FEE,
  );
  if (availableUdtBalance <= estimateAskTokens) {
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message: `At least ${estimateAskTokens} UDT tokens must be available to convert to CKB!`,
      },
    };
  }

  // Lock a live cell for current tx
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

  // Modify the last output(our cell) to charge +bidTokens+ CKBytes,
  // and collect +askTokens+ UDTs
  tx.outputs[tx.outputs.length - 1].capacity -= bidTokens;
  tx.outputsData[tx.outputs.length - 1] = ccc.hexFrom(
    ccc.numLeToBytes(
      ccc.udtBalanceFrom(tx.outputsData[tx.outputs.length - 1]) + askTokens,
      16,
    ),
  );

  // Charge +askTokens+ UDTs from output cells indices by +indices+
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

  // A larger EX value is safer, and won't cost us too much here.
  await dbConnection.setex(
    buildKey(KEY_PREFIX_TX, outPointBytes),
    lockedSeconds * 2,
    ccc.hexFrom(tx.toBytes()),
  );

  return {
    result: {
      valid_until: new Date(parseInt(expiredTimestamp) * 1000).toISOString(),
      transaction: cccA.JsonRpcTransformers.transactionFrom(tx),
      ask_tokens: askTokens,
      bid_tokens: bidTokens,
    },
  };
}

async function confirm(params: any): Promise<Result> {
  // TODO: validate input parameters
  let tx = ccc.Transaction.from(params[0]);
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

  const lockedCellBytes = ccc.hexFrom(
    tx.inputs[tx.inputs.length - 1].previousOutput.toBytes(),
  );
  const txKey = buildKey(KEY_PREFIX_TX, lockedCellBytes);
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
    if (!compareTx(tx, savedTx)) {
      Logger.error(`User provided a modified tx for ${savedTx.hash()}`);
      return INVALID_CELL_ERROR;
    }
  } catch (e) {
    Logger.error(`Parsing saved tx error: ${e}`);
    return INVALID_CELL_ERROR;
  }

  const commitResult = await (dbConnection as any).commitCell(
    KEY_LIVE_CELLS,
    KEY_LOCKED_CELLS,
    KEY_COMMITING_CELLS,
    txKey,
    lockedCellBytes,
    currentTimestamp,
    expiredTimestamp,
  );
  if (!commitResult) {
    return INVALID_CELL_ERROR;
  }
  await dbConnection.del(txKey);

  const signedTxKey = buildKey(KEY_PREFIX_SIGNED_TX, lockedCellBytes);
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
    await (dbConnection as any).cancelCell(
      KEY_LIVE_CELLS,
      KEY_LOCKED_CELLS,
      KEY_COMMITING_CELLS,
      txKey,
      lockedCellBytes,
    );
    return {
      error: {
        code: ERROR_CODE_INVALID_INPUT,
        message,
      },
    };
  }

  return {
    result: {
      transaction: cccA.JsonRpcTransformers.transactionFrom(signedTx),
    },
  };
}

// Only witnesses belonging to users can be tweaked(mainly for signatures)
function compareTx(tx: ccc.Transaction, savedTx: ccc.Transaction): boolean {
  if (
    tx.hash() !== savedTx.hash() ||
    tx.witnesses.length !== savedTx.witnesses.length ||
    tx.witnesses[tx.witnesses.length - 1] !==
      savedTx.witnesses[savedTx.witnesses.length - 1]
  ) {
    return false;
  }
  for (let i = 0; i < tx.witnesses.length - 1; i++) {
    if (tx.witnesses[i].length !== savedTx.witnesses[i].length) {
      return false;
    }
  }
  return true;
}
