import { Worker } from "bullmq";
import { ccc } from "@ckb-ccc/core";

import { dbConnection, queueConnection, env, funder, Logger } from "./env";

const signer = new ccc.SignerCkbPrivateKey(
  funder.client,
  env("FUND_POOL_PRIVATE_KEY"),
);

export const signerWorker = new Worker(
  "signer",
  async (job) => {
    // For now we let BullMQ handles decoding failure
    const tx = ccc.Transaction.fromBytes(job.data.tx);
    const signedTx = await signer.signTransaction(tx);

    switch (job.name) {
      case "sign_send":
        try {
          await signer.client.sendTransaction(signedTx);
        } catch (e) {
          Logger.error(
            `Sending transaction ${signedTx.hash()} receives errors: ${e}`,
          );
        }
        break;
      case "sign":
        await dbConnection.set(
          job.data.targetKey,
          Buffer.from(signedTx.toBytes()),
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
