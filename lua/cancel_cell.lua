-- Cancel a locked / commiting cell

local live_cells_key = KEYS[1]
local locked_cells_key = KEYS[2]
local committing_cells_key = KEYS[3]
local tx_key = KEYS[4]

local cell = ARGV[1]

redis.call("ZREM", locked_cells_key, cell)
redis.call("ZREM", committing_cells_key, cell)
redis.call("DEL", tx_key)
redis.call("SADD", live_cells_key, cell)
