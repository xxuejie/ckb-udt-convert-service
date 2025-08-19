-- Cancel a commiting cell

local locked_cells_key = KEYS[1]
local committing_cells_key = KEYS[2]
local tx_key = KEYS[3]
local signed_tx_key = KEYS[4]

local cell = ARGV[1]

redis.call("ZREM", locked_cells_key, cell)
redis.call("ZREM", committing_cells_key, cell)
redis.call("DEL", tx_key)
redis.call("DEL", signed_tx_key)
