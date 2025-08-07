-- Try lock a live cell for initiate request

local live_cells_key = KEYS[1]
local locked_cells_key = KEYS[2]
local committing_cells_key = KEYS[3]

local current_timestamp = ARGV[1]
local expired_timestamp = ARGV[2]

local function pop()
  local cell = redis.call("SPOP", live_cells_key)
  if cell ~= nil then
    redis.call("ZADD", locked_cells_key, expired_timestamp, cell)
  end
  return cell
end

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

local result = pop()
if result == nil then
  -- If naive attempt does not work, try purging all expired locked cells, then retry
  purge_locked()
  result = pop()
end

return result
