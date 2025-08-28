import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

if (process.env["FUND_POOL_MODE"] !== "multisig") {
  throw new Error("This entry file initializes multisig mode only!");
}

import "./all";
