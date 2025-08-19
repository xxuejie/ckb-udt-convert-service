import { Worker } from "bullmq";
import { ccc } from "@ckb-ccc/core";

import { randomBytes } from "crypto";

import {
  dbConnection,
  queueConnection,
  signerQueue,
  funder,
  udtScript,
  udtCellDeps,
  minUdtCellCkb,
  initialUdtCellCkb,
  ASSEMBLE_BATCH,
} from "./env";
import {
  epoch_timestamp,
  env,
  buildKey,
  cancelAllCommitingCells,
  fetchFeeRate,
  Logger,
  KEY_LIVE_CELLS,
  KEY_LOCKED_CELLS,
  KEY_COMMITING_CELLS,
  KEY_PENDING_TXS,
  KEY_PREFIX_CKB_CELLS,
  KEY_PREFIX_CELL,
  KEY_PREFIX_SIGNED_TX,
} from "./utils";

export const refresherWorker = new Worker(
  "refresher",
  // TODO: maybe we will need redlock to ensure exclusiveness, maybe not
  async (job) => {
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
          cell_output: ccc.hexFrom(cell.cellOutput.toBytes()),
          output_data: ccc.hexFrom(cell.outputData),
        });
      }
      bufferedArgs.push(1);
      bufferedArgs.push(ccc.hexFrom(cell.outPoint.toBytes()));
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

    // Resend pending transactions for committing cells if not yet committed
    const pendingTxs = await dbConnection.lrange(KEY_PENDING_TXS, 0, -1);
    const remainingTxs = [];
    for (const txData of pendingTxs) {
      let parsed: ccc.Transaction | null = null;
      try {
        parsed = ccc.Transaction.fromBytes(txData!);
      } catch (e) {
        Logger.error("Error parsing commiting tx:", e);
        continue;
      }
      const tx = parsed!;
      const txHash = tx.hash();

      const clearTx = async () => {
        await cancelAllCommitingCells(tx, funder, dbConnection);
      };

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
          remainingTxs.push(txData);
        } catch (e) {
          Logger.error(`Sending transaction ${txHash} receives errors: ${e}`);
          await clearTx();
        }
      }
    }
    if (remainingTxs.length > 0) {
      await dbConnection
        .multi()
        .del(KEY_PENDING_TXS)
        .rpush(KEY_PENDING_TXS, ...remainingTxs)
        .exec();
    }
  },
  { connection: queueConnection },
);

refresherWorker.on("failed", (job, error) => {
  Logger.error(`Refresher job ${job?.id} failed:`, error);
});

export const assemblerWorker = new Worker(
  "assembler",
  async (job) => {
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

    const collectingAddress = await ccc.Address.fromString(
      env("COLLECTING_POOL_ADDRESS"),
      funder.client,
    );
    const collectingCellOutput = ccc.CellOutput.from({
      capacity: 0n,
      lock: collectingAddress.script,
      type: udtScript,
    });
    const collectingCellCapacity =
      ccc.fixedPointFrom(collectingCellOutput.occupiedSize) +
      ccc.fixedPointFrom("16");
    collectingCellOutput.capacity = collectingCellCapacity;
    // The extra 1 CKB is set aside for fees
    const MAXIMUM_FEE = ccc.fixedPointFrom("1");
    const extraCapacity = collectingCellCapacity + MAXIMUM_FEE;

    while (liveCkbCells.length > 0) {
      const inputCells = [];
      let capacity = 0n;

      while (
        liveCkbCells.length > 0 &&
        inputCells.length < ASSEMBLE_BATCH &&
        capacity < BigInt(ASSEMBLE_BATCH) * initialUdtCellCkb + extraCapacity
      ) {
        const cell = liveCkbCells.pop()!;
        inputCells.push(cell);
        capacity += cell.cellOutput.capacity;
      }

      if (capacity < initialUdtCellCkb + extraCapacity) {
        continue;
      }

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

      // Build a CKB transaction converting ckb cells to UDT cells
      let outputCount = Number(capacity / initialUdtCellCkb);
      if (outputCount >= ASSEMBLE_BATCH) {
        outputCount = ASSEMBLE_BATCH;
      }
      let spareCapacity = capacity - BigInt(outputCount) * initialUdtCellCkb;
      if (collectedUdtAmount > 0) {
        spareCapacity -= collectingCellCapacity;
      }
      const lockScript = (await funder.getAddressObjSecp256k1()).script;

      const outputs = [];
      const outputsData = [];
      if (collectedUdtAmount > 0) {
        outputs.push(collectingCellOutput);
        outputsData.push(ccc.numLeToBytes(collectedUdtAmount, 16));
      }
      for (let i = 0; i < outputCount; i++) {
        outputs.push({
          capacity: initialUdtCellCkb,
          lock: lockScript,
          type: udtScript,
        });
        outputsData.push(ccc.numLeToBytes(0, 16));
      }
      const spareCellOutput = ccc.CellOutput.from({
        capacity: spareCapacity,
        lock: lockScript,
      });
      if (
        spareCapacity >=
        ccc.fixedPointFrom(spareCellOutput.occupiedSize) + MAXIMUM_FEE
      ) {
        outputs.push(spareCellOutput);
        outputsData.push("0x");
      } else {
        outputs[outputs.length - 1].capacity += spareCapacity;
      }

      const tx = await funder.prepareTransaction({
        inputs: inputCells,
        outputs,
        outputsData,
      });
      tx.addCellDeps(udtCellDeps);
      await tx.completeFeeChangeToOutput(
        funder,
        outputs.length - 1,
        await fetchFeeRate(funder.client),
      );

      await signerQueue.add("sign_send", { tx: ccc.hexFrom(tx.toBytes()) });
    }
  },
  { connection: queueConnection },
);

assemblerWorker.on("failed", (job, error) => {
  Logger.error(`Assembler job ${job?.id} failed:`, error);
});
