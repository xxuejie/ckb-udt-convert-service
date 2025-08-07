-- Refresh Redis info with live cells from CKB

local live_cells_key = KEYS[1]
local locked_cells_key = KEYS[2]
local committing_cells_key = KEYS[3]
local ckb_cells_key = KEYS[4]

local current_timestamp = ARGV[1]

local function purge_expired(key)
  local expired_cells = redis.call("ZRANGE", key,
                                   "-inf", current_timestamp, "BYSCORE")
  redis.call("ZREMRANGEBYSCORE", key, "-inf", current_timestamp)
  return expired_cells
end

local function purge_locked()
  local expired_cells = purge_expired(locked_cells_key)
  for _, cell in ipairs(expired_cells) do
    redis.call("SADD", live_cells_key, cell)
  end
end

purge_locked()
local expired_committing_cells = purge_expired(committing_cells_key)

redis.call("ZDIFFSTORE", ckb_cells_key, 3, ckb_cells_key, locked_cells_key, committing_cells_key)
redis.call("DEL", live_cells_key)
for _, v in ipairs(redis.call("ZRANGE", ckb_cells_key, 0, -1)) do
  redis.call("SADD", live_cells_key, v)
end
redis.call("DEL", ckb_cells_key)

-- Expired committing cells typicall requires more processing(such as logging),
-- since those cells are originally expected to land in CKB.
return expired_committing_cells
