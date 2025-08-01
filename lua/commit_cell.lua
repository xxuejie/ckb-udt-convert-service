-- Commit a locked cell

local live_cells_key = KEYS[1]
local locked_cells_key = KEYS[2]
local committing_cells_key = KEYS[3]
local tx_key = KEYS[4]

local cell = ARGV[1]
local current_timestamp = ARGV[2]
local expired_timestamp = ARGV[3]

local locked_expired_timestamp = redis.call("ZSCORE", locked_cells_key, cell)
if locked_expired_timestamp == nil then 
  return false
end

redis.call("ZREM", locked_cells_key, cell)
if current_timestamp > locked_expired_timestamp then
  redis.call("SADD", live_cells_key, cell)
  redis.call("DEL", tx_key)
  return false
end

redis.call("ZADD", committing_cells_key, cell, expired_timestamp)
