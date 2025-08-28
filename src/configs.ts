import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import fs from "fs";
import { ccc } from "@ckb-ccc/core";

import { env, Logger } from "./utils";

export const udts = JSON.parse(
  fs.readFileSync(env("UDT_SCRIPTS_FILE"), "utf8"),
);
export const udtName = env("ASK_UDT");
export const udtScript = ccc.Script.from(udts[udtName].script);
export const udtInfo = udts[udtName];
export const udtCellDeps = udts[udtName].cellDeps;

export const initialUdtCellCkb = ccc.fixedPointFrom(
  env("INITIAL_UDT_CELL_CKB"),
);
export const minUdtCellCkb = ccc.fixedPointFrom(env("MIN_UDT_CELL_CKB"));
export const maxTradedCkb = ccc.fixedPointFrom(env("MAX_TRADED_CKB"));

export const ASSEMBLE_BATCH = 50;
if (initialUdtCellCkb / minUdtCellCkb >= ASSEMBLE_BATCH) {
  Logger.warn(
    `More than ${ASSEMBLE_BATCH} cells are required to assemble one fund UDT cell!`,
  );
}

export const lockedSeconds = parseInt(env("LOCKED_SECONDS"));
export const commitingSeconds = parseInt(env("COMMITING_SECONDS"));

export const incentivePercent = env("INCENTIVE_PERCENT");
