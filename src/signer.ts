import { Worker } from "bullmq";
import { ccc } from "@ckb-ccc/core";

import { dbConnection, queueConnection, funder } from "./env";
import { env, Logger } from "./utils";

const signer = new ccc.SignerCkbPrivateKey(
  funder.client,
  env("FUND_POOL_PRIVATE_KEY"),
);

export const signerWorker = new Worker(
  "signer",
  async (job) => {
    // For now we let BullMQ handles decoding failure
    const tx = ccc.Transaction.fromBytes(ccc.bytesFrom(job.data.tx));
    const signedTx = await signer.signTransaction(tx);

    switch (job.name) {
      case "sign_send":
        try {
          await signer.client.sendTransaction(signedTx);
        } catch (e) {
          Logger.error(
            `Sending transaction ${signedTx.hash()} receives errors:`,
            e,
          );
        }
        break;
      case "sign":
        await dbConnection.setex(
          job.data.targetKey,
          job.data.ex,
          ccc.hexFrom(signedTx.toBytes()),
        );
        break;
      default:
        throw new Error(`Invalid signer job name: ${job.name}`);
    }
  },
  {
    connection: queueConnection,
  },
);

signerWorker.on("failed", (job, error) => {
  Logger.error(`Signer job ${job?.id} failed:`, error);
});
