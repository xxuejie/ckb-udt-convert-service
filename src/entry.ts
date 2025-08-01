import express from "express";

import { funder } from "./env";
import "./workers";
import "./signer";
import { rpc } from "./rpc";

async function init() {
  const tip = await funder.client.getTipHeader();
  console.log("tip: ", tip);
  const balance = await funder.getBalance();
  console.log("balance: ", balance);
  console.log("addresses: ", await funder.getAddresses());
  // queue.add("refresh", {});

  const app = express();
  app.use(express.json());

  app.post("/rpc", (req, res) => {
    rpc.receive(req.body).then((resp) => {
      if (resp) {
        res.json(resp);
      } else {
        res.sendStatus(204);
      }
    });
  });

  app.listen(process.env["PORT"] || 8000);
}

init();
