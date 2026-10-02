// Beach Chop Spinner API: shared names and picks, stored in the Upstash Redis
// database connected to this project from Vercel → Storage.
//
// GET  /api/spinner            → { items, guests }
// POST /api/spinner { type }   → addGuests | claim | hostCheck, plus host-only
//                                 assign | removeGuest | release | addItem | removeItem | clearAll
//
// Guests (no host key) get one name and one pick per device: their page sends a
// random device id, and the server ties that device to the name it added or
// spun for. Picks are final unless the host releases them.
const crypto = require("crypto");

// SHA-256 of the host key. The key itself is only in the host's link (#host=...).
// Set a HOST_KEY environment variable in Vercel to use a different key instead.
const HOST_KEY_SHA256 = "454639741a3b272e1a8ca97bafd47f285252bb1129cb275bfa9c9181799f89fe";

const K = {
  items: "bc:items",
  claims: "bc:claims",
  guests: "bc:guests",
  guestClaim: "bc:guestclaim",
  deviceGuest: "bc:deviceguest", // device → the name it belongs to
  deviceItem: "bc:deviceitem", // device → the item it picked
  guestDevice: "bc:guestdevice", // name → the device that owns it
  seeded: "bc:seeded",
};
const CATEGORIES = ["main", "chops", "fresh", "drinks", "extras"];
const MAX_GUESTS = 200;
const MAX_ITEMS = 100;
const MENU = [
  ["grilled-chicken", "🍗", "Grilled chicken", "main"],
  ["suya", "🍢", "Suya", "main"],
  ["grilled-sausage", "🌭", "Grilled sausage", "main"],
  ["jollof-rice", "🍚", "Jollof rice", "main"],
  ["french-fries", "🍟", "French fries", "main"],
  ["fried-yam", "🍠", "Fried yam", "main"],
  ["fried-plantain", "🍌", "Fried plantain", "main"],
  ["potato-chips", "🥔", "Potato chips", "main"],
  ["sandwiches", "🥪", "Sandwiches", "main"],
  ["shawarma", "🌯", "Shawarma", "main"],
  ["samosa", "🥟", "Samosa", "chops"],
  ["spring-rolls", "🥠", "Spring rolls", "chops"],
  ["puff-puff", "🍩", "Puff-puff", "chops"],
  ["chin-chin", "🥜", "Chin chin", "chops"],
  ["peppered-gizzard", "🍗", "Peppered gizzard", "chops"],
  ["peppered-meat", "🍢", "Peppered meat", "chops"],
  ["watermelon", "🍉", "Watermelon", "fresh"],
  ["pineapple", "🍍", "Pineapple", "fresh"],
  ["oranges", "🍊", "Oranges", "fresh"],
  ["grapes", "🍇", "Grapes", "fresh"],
  ["fruit-salad", "🥗", "Fruit salad", "fresh"],
  ["bottled-water", "💧", "Bottled water", "drinks"],
  ["soft-drinks", "🥤", "Soft drinks", "drinks"],
  ["juice", "🧃", "Juice", "drinks"],
  ["ice-cooler", "🧊", "Ice + cooler", "drinks"],
  ["ketchup-mayo", "🥫", "Ketchup + mayonnaise", "extras"],
  ["pepper-sauce", "🌶️", "Pepper sauce", "extras"],
  ["disposable-plates", "🍽️", "Disposable plates", "extras"],
  ["disposable-cups", "🥛", "Disposable cups", "extras"],
  ["cutlery", "🍴", "Cutlery", "extras"],
];

// First come, first served: the guest must exist and have no item yet, and the
// first candidate that is still on the menu and unclaimed becomes theirs.
// A guest device (ARGV[3]; empty for the host) gets one pick, only for its own name.
const CLAIM_SCRIPT = `
local guests, claims, guestClaim, items = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local deviceGuest, deviceItem, guestDevice = KEYS[5], KEYS[6], KEYS[7]
local guestId, claim, device = ARGV[1], ARGV[2], ARGV[3]
if redis.call('HEXISTS', guests, guestId) == 0 then return {'noguest', ''} end
local existing = redis.call('HGET', guestClaim, guestId)
if existing then return {'already', existing} end
if device ~= '' then
  local picked = redis.call('HGET', deviceItem, device)
  if picked then return {'devicedone', picked} end
  local mine = redis.call('HGET', deviceGuest, device)
  if mine and mine ~= guestId then return {'notyours', mine} end
  local owner = redis.call('HGET', guestDevice, guestId)
  if owner and owner ~= device then return {'taken', ''} end
end
for i = 4, #ARGV do
  local id = ARGV[i]
  if redis.call('HEXISTS', items, id) == 1 and redis.call('HEXISTS', claims, id) == 0 then
    redis.call('HSET', claims, id, claim)
    redis.call('HSET', guestClaim, guestId, id)
    if device ~= '' then
      redis.call('HSET', deviceGuest, device, guestId)
      redis.call('HSET', deviceItem, device, id)
      redis.call('HSET', guestDevice, guestId, device)
    end
    return {'ok', id}
  end
end
return {'none', ''}`;

// The host gives a guest one particular item. A pick the guest already had goes back
// on the wheel; an item someone else holds is refused. The guest's phone stays locked.
const ASSIGN_SCRIPT = `
local guests, claims, guestClaim, items, deviceItem, guestDevice = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local guestId, itemId, claim = ARGV[1], ARGV[2], ARGV[3]
if redis.call('HEXISTS', guests, guestId) == 0 then return {'noguest', ''} end
if redis.call('HEXISTS', items, itemId) == 0 then return {'noitem', ''} end
local current = redis.call('HGET', guestClaim, guestId)
if current == itemId then return {'same', ''} end
if redis.call('HEXISTS', claims, itemId) == 1 then return {'taken', ''} end
if current then redis.call('HDEL', claims, current) end
redis.call('HSET', claims, itemId, claim)
redis.call('HSET', guestClaim, guestId, itemId)
local device = redis.call('HGET', guestDevice, guestId)
if device then redis.call('HSET', deviceItem, device, itemId) end
return {'ok', current or ''}`;

// Removes field ARGV[1] from KEYS[1] unless KEYS[2] still ties it to a pick (then -1).
const REMOVE_UNCLAIMED_SCRIPT = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return -1 end
return redis.call('HDEL', KEYS[1], ARGV[1])`;

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const FINAL = "Picks are final. Ask the host if something needs to change.";

// Upstash's REST API is preferred; any plain Redis connection string (redis:// or rediss://) works too.
function redisConfig() {
  const env = process.env;
  const names = Object.keys(env);
  const restKey = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"].find((k) => env[k])
    || names.find((k) => /(^|_)(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/.test(k) && env[k]);
  const token = restKey && env[restKey.replace(/URL$/, "TOKEN")];
  if (restKey && token) return { kind: "rest", url: env[restKey].replace(/\/+$/, ""), token };
  const tcpKey = ["REDIS_URL", "KV_URL", "STORAGE_URL"].find((k) => /^rediss?:\/\//.test(env[k] || ""))
    || names.find((k) => /_URL$/.test(k) && /^rediss?:\/\//.test(env[k] || ""));
  if (tcpKey) return { kind: "tcp", url: env[tcpKey] };
  return null;
}

let tcpClient = null;
async function tcp(url) {
  if (!tcpClient) {
    const { createClient } = require("redis");
    const client = createClient({ url, socket: { connectTimeout: 5000 } });
    client.on("error", (err) => console.error("Redis connection error", err));
    tcpClient = client.connect().then(() => client, (err) => { tcpClient = null; throw err; });
  }
  return tcpClient;
}

async function send(cfg, path, payload) {
  const response = await fetch(cfg.url + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(`Redis answered ${response.status}`);
  return data;
}

async function redis(cfg, command) {
  if (cfg.kind === "tcp") return (await tcp(cfg.url)).sendCommand(command.map(String));
  const data = await send(cfg, "", command);
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function pipeline(cfg, commands) {
  if (cfg.kind === "tcp") {
    const client = await tcp(cfg.url);
    return Promise.all(commands.map((command) => client.sendCommand(command.map(String))));
  }
  const data = await send(cfg, "/pipeline", commands);
  if (!Array.isArray(data)) throw new Error("Unexpected pipeline answer");
  return data.map((entry) => {
    if (entry.error) throw new Error(entry.error);
    return entry.result;
  });
}

function toMap(result) {
  if (Array.isArray(result)) {
    const out = {};
    for (let i = 0; i < result.length; i += 2) out[result[i]] = result[i + 1];
    return out;
  }
  return result && typeof result === "object" ? result : {};
}

function parse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function clean(text, max) {
  if (typeof text !== "string") return "";
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

function slugify(text) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

const randomId = () => crypto.randomBytes(3).toString("hex");

function isHost(key) {
  if (typeof key !== "string" || !key) return false;
  const expected = process.env.HOST_KEY
    ? crypto.createHash("sha256").update(process.env.HOST_KEY).digest()
    : Buffer.from(HOST_KEY_SHA256, "hex");
  const given = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(expected, given);
}

let seeded = false;
async function seedOnce(cfg) {
  if (seeded) return;
  const first = await redis(cfg, ["SET", K.seeded, "1", "NX"]);
  if (first === "OK") {
    const command = ["HSET", K.items];
    MENU.forEach(([id, emoji, label, category], i) => {
      command.push(id, JSON.stringify({ label, emoji, category, order: i + 1 }));
    });
    await redis(cfg, command);
  }
  seeded = true;
}

async function readState(cfg) {
  const [items, claims, guests] = await pipeline(cfg, [
    ["HGETALL", K.items],
    ["HGETALL", K.claims],
    ["HGETALL", K.guests],
  ]);
  const claimMap = toMap(claims);
  return {
    items: Object.entries(toMap(items)).map(([id, raw]) => {
      const item = parse(raw);
      if (!item || !item.label) return null;
      const claim = parse(claimMap[id]);
      return {
        id,
        label: item.label,
        emoji: item.emoji || "",
        category: item.category,
        order: item.order || 0,
        guestId: claim ? claim.guestId : null,
        guestName: claim ? claim.guestName : null,
        claimedAt: claim ? claim.claimedAt : null,
      };
    }).filter(Boolean),
    guests: Object.entries(toMap(guests)).map(([id, raw]) => {
      const guest = parse(raw);
      return guest && guest.name ? { id, name: guest.name, addedAt: guest.addedAt || 0 } : null;
    }).filter(Boolean),
  };
}

function deviceOf(body) {
  const device = clean(body.device, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) throw new ApiError(400, "invalid_argument", "Reload the page and try again.");
  return device;
}

async function addGuests(cfg, body, host) {
  const names = Array.isArray(body.names) ? body.names.map((n) => clean(n, 40)).filter(Boolean).slice(0, 50) : [];
  if (!names.length) throw new ApiError(400, "invalid_argument", "Type a name first.");
  const device = host ? "" : deviceOf(body);
  if (!host) {
    if (names.length > 1) throw new ApiError(400, "one_name", "Add just your own name.");
    const mine = await redis(cfg, ["HGET", K.deviceGuest, device]);
    if (mine) throw new ApiError(409, "already_added", "You've already added your name on this phone.", { guestId: mine });
  }
  const existing = Object.entries(toMap(await redis(cfg, ["HGETALL", K.guests])))
    .map(([id, raw]) => ({ id, ...(parse(raw) || {}) }))
    .filter((g) => g.name);
  const byName = new Map(existing.map((g) => [g.name.toLocaleLowerCase(), g]));
  const ids = new Set(existing.map((g) => g.id));
  const added = [];
  const dupes = [];
  for (const name of names) {
    const known = byName.get(name.toLocaleLowerCase());
    if (known) { dupes.push({ id: known.id, name: known.name }); continue; }
    if (ids.size >= MAX_GUESTS) throw new ApiError(400, "limit", `The list is full at ${MAX_GUESTS} names.`);
    let id = "g-" + (slugify(name) || randomId());
    if (ids.has(id)) id += "-" + randomId();
    const created = await redis(cfg, ["HSETNX", K.guests, id, JSON.stringify({ name, addedAt: Date.now() })]);
    if (created) added.push({ id, name });
    else dupes.push({ id, name });
    ids.add(id);
    byName.set(name.toLocaleLowerCase(), { id, name });
  }
  if (device && added.length) {
    await pipeline(cfg, [["HSET", K.deviceGuest, device, added[0].id], ["HSET", K.guestDevice, added[0].id, device]]);
  }
  return { added, dupes };
}

async function claim(cfg, body, host) {
  const device = host ? "" : deviceOf(body);
  const guestId = clean(body.guestId, 80);
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.map((c) => clean(c, 80)).filter(Boolean).slice(0, MAX_ITEMS)
    : [];
  if (!guestId || !candidates.length) throw new ApiError(400, "invalid_argument", "Pick a name and spin again.");
  const guest = parse(await redis(cfg, ["HGET", K.guests, guestId]));
  if (!guest) throw new ApiError(409, "no_guest", "That name isn't on the list anymore. Pick it again.");
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const record = JSON.stringify({ guestId, guestName: guest.name, claimedAt: Date.now() });
  const [status, value] = await redis(cfg, [
    "EVAL", CLAIM_SCRIPT, "7", K.guests, K.claims, K.guestClaim, K.items, K.deviceGuest, K.deviceItem, K.guestDevice,
    guestId, record, device, ...candidates,
  ]);
  if (status === "ok") return { itemId: value };
  if (status === "already") return { already: true, itemId: value };
  if (status === "noguest") throw new ApiError(409, "no_guest", "That name isn't on the list anymore. Pick it again.");
  if (status === "devicedone") throw new ApiError(409, "already_picked", `You've already picked on this phone. ${FINAL}`);
  if (status === "notyours") throw new ApiError(409, "not_yours", "This phone can only spin for the name it added.", { guestId: value });
  if (status === "taken") throw new ApiError(409, "name_taken", `${guest.name} is already being used on someone else's phone. Pick your own name.`);
  return { itemId: null };
}

// Puts a pick back: the food returns to the wheel, and that person's phone may spin again.
async function release(cfg, body) {
  const id = clean(body.id, 80);
  const record = parse(await redis(cfg, ["HGET", K.claims, id]));
  if (!record) return { ok: true };
  const device = await redis(cfg, ["HGET", K.guestDevice, record.guestId]);
  const commands = [["HDEL", K.claims, id], ["HDEL", K.guestClaim, record.guestId]];
  if (device) commands.push(["HDEL", K.deviceItem, device]);
  await pipeline(cfg, commands);
  return { ok: true };
}

async function assign(cfg, body) {
  let name = clean(body.name, 40);
  const itemId = clean(body.itemId, 80);
  if (!name || !itemId) throw new ApiError(400, "invalid_argument", "Type a name and choose a food.");
  const guests = Object.entries(toMap(await redis(cfg, ["HGETALL", K.guests])))
    .map(([id, raw]) => ({ id, ...(parse(raw) || {}) }))
    .filter((g) => g.name);
  const known = guests.find((g) => g.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  let guestId;
  if (known) {
    guestId = known.id;
    name = known.name;
  } else {
    if (guests.length >= MAX_GUESTS) throw new ApiError(400, "limit", `The list is full at ${MAX_GUESTS} names.`);
    guestId = "g-" + (slugify(name) || randomId());
    if (guests.some((g) => g.id === guestId)) guestId += "-" + randomId();
    await redis(cfg, ["HSETNX", K.guests, guestId, JSON.stringify({ name, addedAt: Date.now() })]);
  }
  const record = JSON.stringify({ guestId, guestName: name, claimedAt: Date.now() });
  const [status, previous] = await redis(cfg, [
    "EVAL", ASSIGN_SCRIPT, "6", K.guests, K.claims, K.guestClaim, K.items, K.deviceItem, K.guestDevice,
    guestId, itemId, record,
  ]);
  if (status === "ok") return { guestId, name, previous: previous || null };
  if (status === "same") return { guestId, name, previous: null };
  if (status === "noitem") throw new ApiError(409, "no_item", "That food isn't on the menu anymore.");
  if (status === "taken") {
    const holder = parse(await redis(cfg, ["HGET", K.claims, itemId]));
    const item = parse(await redis(cfg, ["HGET", K.items, itemId]));
    throw new ApiError(409, "item_taken",
      `${item ? item.label : "That food"} is already taken by ${holder ? holder.guestName : "someone"}. Tap ↺ on it in the lineup first.`);
  }
  throw new ApiError(409, "no_guest", "That name isn't on the list anymore. Try again.");
}

async function removeGuest(cfg, body) {
  const id = clean(body.id, 80);
  const removed = await redis(cfg, ["EVAL", REMOVE_UNCLAIMED_SCRIPT, "2", K.guests, K.guestClaim, id]);
  if (removed === -1) throw new ApiError(409, "invalid_argument", "That person already has a pick. Put it back on the wheel first.");
  // Free the phone that added this name, so it can add the right one.
  const device = await redis(cfg, ["HGET", K.guestDevice, id]);
  if (device) {
    await pipeline(cfg, [["HDEL", K.guestDevice, id], ["HDEL", K.deviceGuest, device], ["HDEL", K.deviceItem, device]]);
  }
  return { ok: true };
}

async function addItem(cfg, body) {
  const label = clean(body.label, 40);
  const emoji = clean(body.emoji, 4);
  const category = CATEGORIES.includes(body.category) ? body.category : "extras";
  if (!label) throw new ApiError(400, "invalid_argument", "Give the item a name.");
  const items = Object.entries(toMap(await redis(cfg, ["HGETALL", K.items])))
    .map(([id, raw]) => ({ id, ...(parse(raw) || {}) }));
  if (items.length >= MAX_ITEMS) throw new ApiError(400, "limit", `The menu is full at ${MAX_ITEMS} items.`);
  if (items.some((it) => (it.label || "").toLocaleLowerCase() === label.toLocaleLowerCase())) {
    throw new ApiError(409, "duplicate", `${label} is already on the menu.`);
  }
  let id = "x-" + (slugify(label) || randomId());
  if (items.some((it) => it.id === id)) id += "-" + randomId();
  const order = items.reduce((max, it) => Math.max(max, it.order || 0), 0) + 1;
  await redis(cfg, ["HSETNX", K.items, id, JSON.stringify({ label, emoji, category, order })]);
  return { ok: true, id };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const cfg = redisConfig();
  if (!cfg) {
    return res.status(503).json({
      error: "not_configured",
      message: "Connect a Redis database (Upstash or Redis) to this project in Vercel (Storage tab), then redeploy.",
    });
  }
  try {
    if (req.method === "GET") {
      await seedOnce(cfg);
      return res.status(200).json(await readState(cfg));
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed", message: "Use GET or POST." });
    }
    const body = typeof req.body === "string" ? parse(req.body) || {} : req.body || {};
    const host = isHost(body.hostKey);
    const hostOnly = ["assign", "removeGuest", "release", "addItem", "removeItem", "clearAll"];
    if (hostOnly.includes(body.type) && !host) {
      throw new ApiError(403, "not_host", "Only the host can do that.");
    }
    switch (body.type) {
      case "addGuests":
        return res.status(200).json(await addGuests(cfg, body, host));
      case "claim":
        return res.status(200).json(await claim(cfg, body, host));
      case "hostCheck":
        return res.status(200).json({ ok: host });
      case "assign":
        return res.status(200).json(await assign(cfg, body));
      case "removeGuest":
        return res.status(200).json(await removeGuest(cfg, body));
      case "release":
        return res.status(200).json(await release(cfg, body));
      case "addItem":
        return res.status(200).json(await addItem(cfg, body));
      case "removeItem": {
        const removed = await redis(cfg, ["EVAL", REMOVE_UNCLAIMED_SCRIPT, "2", K.items, K.claims, clean(body.id, 80)]);
        if (removed === -1) throw new ApiError(409, "invalid_argument", "Someone already claimed that. Put it back on the wheel first.");
        return res.status(200).json({ ok: true });
      }
      case "clearAll":
        await pipeline(cfg, [["DEL", K.claims], ["DEL", K.guestClaim], ["DEL", K.deviceItem]]);
        return res.status(200).json({ ok: true });
      default:
        throw new ApiError(400, "invalid_argument", "Unknown request.");
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ ...err.extra, error: err.code, message: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "unavailable", message: "The database didn't answer. Try again in a moment." });
  }
};
