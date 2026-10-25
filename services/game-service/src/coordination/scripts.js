// Lua scripts run atomically inside Redis. Lease values look like "<instanceId>|<epoch>".
// The epoch is a per-room fencing token that grows every time ownership changes hands.

// KEYS[1]=owner lease, KEYS[2]=epoch counter  ARGV[1]=instanceId  ARGV[2]=lease ttl ms  ARGV[3]=epoch ttl ms
// Returns the new epoch, or 0 when somebody else holds the lease.
const ACQUIRE = `
local e = (tonumber(redis.call('GET', KEYS[2])) or 0) + 1
local ok = redis.call('SET', KEYS[1], ARGV[1] .. '|' .. e, 'NX', 'PX', ARGV[2])
if not ok then return 0 end
redis.call('SET', KEYS[2], e, 'PX', ARGV[3])
return e
`

// compare-and-renew: KEYS[1]=owner lease  ARGV[1]=expected value  ARGV[2]=ttl ms  -> 1 renewed / 0 not the owner any more
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`

// compare-and-release: KEYS[1]=owner lease  ARGV[1]=expected value  -> 1 released / 0 not the owner
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

// compare-and-delete for the user -> room index: KEYS[1]=user key  ARGV[1]=room code
const CLEAR_IF = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

module.exports = { ACQUIRE, RENEW, RELEASE, CLEAR_IF }
