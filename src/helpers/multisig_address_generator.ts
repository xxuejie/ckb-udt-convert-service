import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import { Command } from "commander";
import { ccc } from "@ckb-ccc/core";
import fs from "fs";

import { buildCccClient } from "../utils";
import { parseMultisigConfig, multisigCkbScript } from "../multisig/utils";

const program = new Command()
  .option("-r, --required <requiredAddresses...>", "required addresses")
  .option("-a, --addresses <normalAddresses...>", "normal addresses")
  .requiredOption("-m, --threshold <threshold>", "threshold")
  .option("-o, --output <output>", "output file name");
program.parse();

async function run() {
  const client = buildCccClient();

  const required = program.opts().required || [];
  const addresses = program.opts().addresses || [];
  const pubkeys = [];
  const endpoints = [];

  const scriptInfo = await client.getKnownScript(
    ccc.KnownScript.Secp256k1Blake160,
  );
  for (const a of required.concat(addresses)) {
    const address = await ccc.Address.fromString(a, client);
    if (
      address.script.codeHash !== scriptInfo.codeHash ||
      address.script.hashType !== scriptInfo.hashType
    ) {
      throw new Error(`Address ${a} does not use secp256k1 singlesig script!`);
    }
    pubkeys.push(address.script.args);
    endpoints.push("TODO: replace this with actual endpoint!");
  }

  const rawConfig = {
    r: required.length,
    m: program.opts().threshold,
    pubkeys,
    endpoints,
  };
  const config = parseMultisigConfig(rawConfig);

  const output = program.opts().output;
  if (output !== undefined) {
    fs.writeFileSync(output, JSON.stringify(config, null, 2));
  }

  const multisigAddress = ccc.Address.fromScript(
    await multisigCkbScript(config, client),
    client,
  );

  console.log("Multisig address: ", multisigAddress.toString());
  if (output !== undefined) {
    console.log(`Please revise ${output} file with the correct endpoints!`);
  }
}

run().catch((e) => {
  console.error("Error occurs:", e);
  process.exit(1);
});
