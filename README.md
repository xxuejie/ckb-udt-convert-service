# ckb-udt-convert-service

Here we build a service that can assist the assembling of CKB transactions, by converting UDTs into CKBytes instantly. See [this post](https://talk.nervos.org/t/udt-payment-solutions/8956) for more details.

## Usage

`ckb-udt-convert-service` is architected as a node.js server. One can utilize any possible deployment solutions, such as [pm2](https://pm2.keymetrics.io/), or simply pack the node.js server in a docker container. Config files are required to tweak tunnable parameters, such as:

* Percentage of fees charged by the convert service;
* Valid time after an instant convert action has been created;
* The maximal CKBytes traded to users in one request;
* External services providing real-time price between UDT and CKB;
* (Optionally) multisig configuration for fund pool;
* The minimal maintained CKBytes for each fund cell.

We don't yet have this implemented, but a proper convert service should expose certain internal metrics to ops requirement, such as the number of fund cells, the available CKBytes to use.

`ckb-udt-convert-service` has 2 dependencies:

* A CKB RPC with `chain`, `pool` and `indexer` modules enabled;
* A Redis instance, we recommend latest Redis 8.x stable releases.

To run `ckb-udt-convert-service`, follow the steps below:

```
$ git clone https://github.com/xxuejie/ckb-udt-convert-service
$ cd ckb-udt-convert-service
$ pnpm install
$ cp .env.sample .env
$ cp udts.json.sample udts.json
$ # Edit .env, udts.json and (if needed) devnet-offckb.json files
$ npm run build
$ node dist/entries/singlesig_all.js
```

`ckb-udt-convert-service` uses [pino](https://github.com/pinojs/pino) for logging, when running locally, `pino-pretty` aids to generate human readable log messages:

```
$ npm install -g pino-pretty
$ node dist/entries/singlesig_all.js | pino-pretty
```

`.env` file in the repository folder contains tunnable parameters required by `ckb-udt-convert-service`, a sample of `.env` looks like following:

```bash
# Redis instance used by BullMQ background worker 
REDIS_MQ_URL="redis://127.0.0.1:26379/1"
# Redis instance required by the instant convert service itself. It is recommended
# that different Redis instances are used for the 2 cases. As hinted by config here,
# we can use different Redis databases of the same Redis process.
REDIS_DB_URL="redis://127.0.0.1:26379/0"
# CKB RPC information
CKB_RPC_URL="https://testnet.ckbapp.dev"
# CKB network type, supported values are mainnet, testnet anddevnet
CKB_NETWORK="testnet"
# This value points to a local file for on-chain script deployment information. Only
# devnet uses this value. Testnet / mainnet environments would rely on embedded config
# in ccc. In fact, the ckb-udt-convert-service only requires the singlesig / multisig
# lock configuration to be present in this file. One additional requirement, is that ccc
# requires NervosDAO script config to be available in this file.
SCRIPT_CONFIG_FILE="devnet-offckb.json"
# Singlesig private key for fund pool. See the corresponding article on Nervos Talk for
# details. Later we shall revise this field for multisig case.
FUND_POOL_PRIVATE_KEY="0x"
# Address for UDTs collected by the instant pool service. This shall be a different address
# than the fund pool address.
COLLECTING_POOL_ADDRESS=ckt...
# This contains one or more(in future cases) UDTs used by the instant convert service.
# We do acknowledge that a UDT script configuration is available in ccc. However, real UDTs
# could utilize more than one UDT deployments. For example, USDI on CKB is using a special
# UDT deployment which is different from ccc's embedded UDT config for both testnet and mainnet
# environment. As a result, we use a separate file to maintain script information for different
# UDTs.
UDT_SCRIPTS_FILE="udts.json"
# For the moment, our instant convert service only trades between one particular UDT and CKB.
# This value denotes the UDT type in udts.json file
ASK_UDT="usdi-udt"
# The CKBytes held by each fund cell at creation time. The value is denoted as a string of CKBytes,
# such as 500, 1000.15, 20000.4444
INITIAL_UDT_CELL_CKB="500.2"
# The minimal CKBytes for a fund cell, any fund cell with CKBytes lower than this value is
# considered as insufficient cell.
MIN_UDT_CELL_CKB="300.1"
# The lock time for fund cells when initiate action completes. Any fund cell that hasn't seen
# the corresponding confirm action will be released for other users.
LOCKED_SECONDS="60"
# The lock time for fund cells when confirm operation completes. This is also the maximum time
# availble for a transaction to be committed on chain. Typically, any expired transaction at this
# stage should be logged for diagnosis. We should work to minimize the number of transactions exceeding
# this time limit.
COMMITING_SECONDS="60"
# Refresher intervals. Refresher is a background job which reads latest live cells in fund pool,
# and then update records in Redis accordingly. In addition, it will periodically re-broadcasts
# committing transactions(created by confirm action but have yet to be committed on chain) to CKB.
REFRESHER_TRIGGER_SECONDS=30
# Assembler intervals. Assembler is a background job which collects empty cells (cells with no cell data
# and no type script) and insufficent cells in fund pools, and rebuids them to fund cells. As a side
# effect, it also sends collected UDTs to collecting address.
ASSEMBLER_TRIGGER_SECONDS=120
# Methods for fetching latest price between UDT and CKB, 3 modes are supported:
# * binance: The latest price is obtained via Binance API. When this mode is used, the specific
#   trading pair name must be provided in udts.json. Note that to amortize for short-time price
#   changes, our current implementation fetches weighted average price, see the following link
#   for details:
#   https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#individual-symbol-ticker-streams
#   The w field in this API is obtained as the current price. Since it is the average time accumulated
#   over a certain amount of time, it might differ from latest price.
# * custom: Our instant convert service does not aim to update the price, but instead reads price
#   from Redis directly. This method works when you already have a service maintaining latest
#   trading price across all products. Assuming ASK_UDT value mentioned above contains "usdi-udt". When
#   this mode is enabled, the instant convert service would try to read a pair named "PRICE:usdi-udt" from
#   the Redis instance denoted by "REDIS_DB_URL". A fixed point number in string form shall be stored in
#   this key. It represents the UDT charged for 1 CKB.
# * When none of the above 2 modes are used, the instant convert service would try to parse current value
#   as a fixed point number in string form, representing the UDT charged for 1 CKB.
PRICE_STRATEGY=binance
# The percentage of UDT price charged by the instant convert service as operational cost. Assuming
# current value is 0.03, 3% additional UDTs will be charged for each CKB.
INCENTIVE_PERCENT=0.03
# Port for the RPC service, when omitted, the default value is 8000
PORT=10001
# HTTP POST path for the jsonrpc server, when omitted, the default value is "/rpc"
RPC_PATH=/a36645c85487c9576a5ce3ddccc1c056c7e2f7e13cf6e18ef5e369b79c1fb48e/rpc
```
