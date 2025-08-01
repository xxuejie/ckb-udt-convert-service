import { Worker } from "bullmq";
import { ccc } from "@ckb-ccc/core";

import { randomBytes } from "crypto";

import {
  dbConnection,
  queueConnection,
  signerQueue,
  funder,
  udtArgs,
  minUdtCellCkb,
  initialUdtCellCkb,
  Logger,
  ASSEMBLE_BATCH,
} from "./env";
import {
  epoch_timestamp,
  buildKey,
  buildUdtScript,
  KEY_LIVE_CELLS,
  KEY_LOCKED_CELLS,
  KEY_COMMITING_CELLS,
  KEY_PREFIX_CKB_CELLS,
  KEY_PREFIX_CELL,
  KEY_PREFIX_SIGNED_TX,
} from "./utils";

export const refresherWorker = new Worker(
  "refresher",
  // TODO: maybe we will need redlock to ensure exclusiveness, maybe not
  async (job) => {
    const udtScript = await buildUdtScript(funder);
    const current_timestamp = epoch_timestamp();

    // Here we have 2 kinds of cells:
    // * UDT cells can be used to fulfill a convert service, it accepts UDTs
    // while giving out CKBs
    // * CKB cells are plain CKB cells, or UDT cells with too little CKBs to
    // be useful, they will be convered to UDT cells for later usage
    const queriedUdtCells = await Array.fromAsync(
      funder.findCells(
        {
          script: udtScript,
        },
        true,
        "asc",
        100,
      ),
    );
    // Some liveUdtCells should be ckb cells, since they contain too
    // little CKBs
    const liveUdtCells = [];
    for (const cell of queriedUdtCells) {
      if (cell.cellOutput.capacity >= minUdtCellCkb) {
        liveUdtCells.push(cell);
      }
    }

    // For live UDT cells, store cell info in redis if not already done
    const ckbCellKey = buildKey(KEY_PREFIX_CKB_CELLS, randomBytes(48));
    const bufferedArgs = [];
    for (const cell of liveUdtCells) {
      const key = buildKey(KEY_PREFIX_CELL, cell.outPoint.toBytes());
      if ((await dbConnection.exists([key])) !== 1) {
        await dbConnection.hset(key, {
          cell_output: cell.cellOutput.toBytes(),
          output_data: ccc.bytesFrom(cell.outputData),
        });
      }
      bufferedArgs.push(1);
      bufferedArgs.push(Buffer.from(cell.outPoint.toBytes()));
      if (bufferedArgs.length >= 100) {
        await dbConnection.zadd(ckbCellKey, ...bufferedArgs);
      }
    }
    if (bufferedArgs.length > 0) {
      await dbConnection.zadd(ckbCellKey, ...bufferedArgs);
    }
    // Use Redis script to update live cell metadata
    await (dbConnection as any).refresh(
      KEY_LIVE_CELLS,
      KEY_LOCKED_CELLS,
      KEY_COMMITING_CELLS,
      ckbCellKey,
      current_timestamp,
    );

    // Resend transactions for committing cells to CKB if not yet committed
    for (const committingCell of await dbConnection.zrange(
      KEY_COMMITING_CELLS,
      0,
      -1,
    )) {
      const txKey = buildKey(KEY_PREFIX_SIGNED_TX, committingCell);
      const clearTx = async () => {
        await dbConnection.zrem(KEY_COMMITING_CELLS, committingCell);
        await dbConnection.del(txKey);
      };

      let parsed: ccc.Transaction | null = null;
      try {
        const txData = await dbConnection.get(txKey);
        parsed = ccc.Transaction.fromBytes(txData!);
      } catch (e) {
        Logger.error(`Error parsing tx: ${e}`);
        await clearTx();
        continue;
      }
      const tx = parsed!;
      const txHash = tx.hash();

      const txStatus = (await funder.client.getTransactionNoCache(txHash))!
        .status;
      if (txStatus === "committed") {
        await clearTx();
      } else if (txStatus === "rejected") {
        Logger.error(`Transaction ${txHash} is rejected!`);
        await clearTx();
      } else if (txStatus === "unknown") {
        // Try resending the transaction
        try {
          await funder.client.sendTransaction(tx);
        } catch (e) {
          Logger.error(`Sending transaction ${txHash} receives errors: ${e}`);
          await clearTx();
        }
      }
    }
  },
  { connection: queueConnection },
);

export const assemblerWorker = new Worker(
  "assembler",
  async (job) => {
    const udtScript = await buildUdtScript(funder);

    // See refresher worker for details
    const queriedUdtCells = await Array.fromAsync(
      funder.findCells(
        {
          script: udtScript,
        },
        true,
        "asc",
        100,
      ),
    );
    const liveCkbCells = await Array.fromAsync(
      funder.findCells(
        {
          scriptLenRange: [0, 1],
          outputDataLenRange: [0, 1],
        },
        true,
        "asc",
        100,
      ),
    );
    // Some liveUdtCells should be ckb cells, since they contain too
    // little CKBs
    const liveUdtCells = [];
    for (const cell of queriedUdtCells) {
      if (cell.cellOutput.capacity < minUdtCellCkb) {
        liveCkbCells.push(cell);
      }
    }

    // Assemble CKB cells into UDT cells if possible
    liveCkbCells.sort((a, b) => {
      const aCapacity = a.cellOutput.capacity;
      const bCapacity = b.cellOutput.capacity;

      if (aCapacity > bCapacity) {
        return 1;
      } else if (aCapacity < bCapacity) {
        return -1;
      } else {
        return 0;
      }
    });
    while (liveCkbCells.length > 0) {
      const inputCells = [];
      let capacity = 0n;

      while (
        liveCkbCells.length > 0 &&
        inputCells.length < ASSEMBLE_BATCH &&
        capacity <
          BigInt(ASSEMBLE_BATCH) * initialUdtCellCkb + ccc.fixedPointFrom("1")
      ) {
        const cell = liveCkbCells.pop()!;
        inputCells.push(cell);
        capacity += cell.cellOutput.capacity;
      }

      // The extra 1 CKB is set aside for building fees
      if (capacity < initialUdtCellCkb + ccc.fixedPointFrom("1")) {
        continue;
      }

      // Build a CKB transaction converting ckb cells to UDT cells
      const outputCount = capacity / initialUdtCellCkb;
      const spareCapacity = capacity - outputCount * initialUdtCellCkb;
      const lockScript = (await funder.getAddressObjSecp256k1()).script;
      const collectedUdtAmount = inputCells
        .map((cell) => {
          if (
            cell.cellOutput.type !== undefined &&
            cell.cellOutput.type.eq(udtScript)
          ) {
            return ccc.udtBalanceFrom(cell.outputData);
          } else {
            return 0n;
          }
        })
        .reduce((acc, val) => acc + val, 0n);

      const outputs = [...Array(outputCount)].map((_, _i) => {
        return {
          capacity: initialUdtCellCkb,
          lock: lockScript,
          type: udtScript,
        };
      });
      const outputsData = [...Array(outputCount)].map((_, _i) => {
        return ccc.numLeToBytes(0, 16);
      });
      outputs[0].capacity += spareCapacity;
      outputsData[0] = ccc.numLeToBytes(collectedUdtAmount, 16);

      const tx = await funder.prepareTransaction({
        inputs: inputCells,
        outputs,
        outputsData,
      });
      await tx.addCellDepsOfKnownScripts(funder.client, ccc.KnownScript.XUdt);

      await signerQueue.add("sign_send", { tx: tx.toBytes() });
    }
  },
  { connection: queueConnection },
);
