import { funder } from "./env";
import "./workers";
import "./signer";

async function init() {
  const tip = await funder.client.getTipHeader();
  console.log("tip: ", tip);
  const balance = await funder.getBalance();
  console.log("balance: ", balance);
  console.log("addresses: ", await funder.getAddresses());
  // queue.add("refresh", {});
}

init();
