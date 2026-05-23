const VECTOR_DIMS = 14;
const REF_SIZE = VECTOR_DIMS * 2 + 1;
const VECTOR_SCALE = 10000;
const INDEX_BUCKETS = 131072;
const K_NEIGHBORS = 5;

const port = Number.parseInt(process.env.PORT || "9999", 10);
const referencesPath = process.env.REFERENCES_PATH || "resources/example-references.bin";
const candidateLimit = Math.max(1, Number.parseInt(process.env.CANDIDATE_LIMIT || "125", 10));
const maxReferencesEnv = Number.parseInt(process.env.MAX_REFERENCES || "0", 10);

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function quantize(value) {
  const scaled = Math.round(value * VECTOR_SCALE);
  if (scaled < -10000) return -10000;
  if (scaled > 10000) return 10000;
  return scaled;
}

function bin01(value, bins) {
  let clamped = value;
  if (clamped < 0) clamped = 0;
  if (clamped > 10000) clamped = 10000;
  const bin = Math.floor((clamped * bins) / 10001);
  return bin >= bins ? bins - 1 : bin;
}

function bucketKeyFromBins(amount, hour, txCount, online, cardPresent, unknownMerchant, mcc) {
  return ((((((amount * 8 + hour) * 8 + txCount) * 2 + online) * 2 + cardPresent) * 2 + unknownMerchant) * 8 + mcc);
}

function bucketKeyAt(buffer, offset) {
  const amount = bin01(buffer.readInt16LE(offset), 32);
  const hour = bin01(buffer.readInt16LE(offset + 6), 8);
  const txCount = bin01(buffer.readInt16LE(offset + 16), 8);
  const online = buffer.readInt16LE(offset + 18) >= 5000 ? 1 : 0;
  const card = buffer.readInt16LE(offset + 20) >= 5000 ? 1 : 0;
  const unknown = buffer.readInt16LE(offset + 22) >= 5000 ? 1 : 0;
  const mcc = bin01(buffer.readInt16LE(offset + 24), 8);
  return bucketKeyFromBins(amount, hour, txCount, online, card, unknown, mcc);
}

function bucketKeyQuery(query) {
  const amount = bin01(query[0], 32);
  const hour = bin01(query[3], 8);
  const txCount = bin01(query[8], 8);
  const online = query[9] >= 5000 ? 1 : 0;
  const card = query[10] >= 5000 ? 1 : 0;
  const unknown = query[11] >= 5000 ? 1 : 0;
  const mcc = bin01(query[12], 8);
  return bucketKeyFromBins(amount, hour, txCount, online, card, unknown, mcc);
}

function loadReferences(path) {
  const file = Bun.file(path);
  return file.arrayBuffer().then((arrayBuffer) => {
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "R26B") {
      throw new Error(`invalid references file: ${path}`);
    }

    const total = buffer.readUInt32LE(4);
    const target = maxReferencesEnv > 0 && maxReferencesEnv < total ? maxReferencesEnv : total;
    const stride = Math.max(1, Math.floor(total / target));
    const count = Math.ceil(total / stride);
    const offsets = new Uint32Array(count);
    const heads = new Int32Array(INDEX_BUCKETS);
    const next = new Int32Array(count);
    heads.fill(-1);

    let loaded = 0;
    for (let source = 0; source < total && loaded < count; source += stride) {
      const refOffset = 8 + source * REF_SIZE;
      offsets[loaded] = refOffset;
      const key = bucketKeyAt(buffer, refOffset);
      next[loaded] = heads[key];
      heads[key] = loaded;
      loaded++;
    }

    return { buffer, offsets, heads, next, count: loaded };
  });
}

function isoWeekdayMonday0(year, month, day) {
  if (month < 3) {
    month += 12;
    year--;
  }
  const k = year % 100;
  const j = Math.floor(year / 100);
  const h = (day + Math.floor((13 * (month + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  const sunday0 = (h + 6) % 7;
  return (sunday0 + 6) % 7;
}

function daysFromCivil(year, month, day) {
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function parseIsoParts(value) {
  return [
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8, 10)),
    Number(value.slice(11, 13)),
    Number(value.slice(14, 16)),
  ];
}

function minutesBetweenIso(older, newer) {
  const [y1, mo1, d1, h1, mi1] = parseIsoParts(older);
  const [y2, mo2, d2, h2, mi2] = parseIsoParts(newer);
  const total1 = daysFromCivil(y1, mo1, d1) * 1440 + h1 * 60 + mi1;
  const total2 = daysFromCivil(y2, mo2, d2) * 1440 + h2 * 60 + mi2;
  return Math.max(0, total2 - total1);
}

function mccRisk(mcc) {
  switch (mcc) {
    case "5411": return 0.15;
    case "5812": return 0.30;
    case "5912": return 0.20;
    case "5944": return 0.45;
    case "7801": return 0.80;
    case "7802": return 0.75;
    case "7995": return 0.85;
    case "4511": return 0.35;
    case "5311": return 0.25;
    case "5999": return 0.50;
    default: return 0.50;
  }
}

function merchantIsKnown(customer, merchantId) {
  const merchants = customer.known_merchants;
  for (let i = 0; i < merchants.length; i++) {
    if (merchants[i] === merchantId) return true;
  }
  return false;
}

function vectorize(payload) {
  const tx = payload.transaction;
  const customer = payload.customer;
  const merchant = payload.merchant;
  const terminal = payload.terminal;
  const [year, month, day, hour] = parseIsoParts(tx.requested_at);
  const last = payload.last_transaction;
  const query = new Int16Array(VECTOR_DIMS);

  query[0] = quantize(clamp01(tx.amount / 10000));
  query[1] = quantize(clamp01(tx.installments / 12));
  query[2] = quantize(customer.avg_amount <= 0 ? 1 : clamp01((tx.amount / customer.avg_amount) / 10));
  query[3] = quantize(clamp01(hour / 23));
  query[4] = quantize(clamp01(isoWeekdayMonday0(year, month, day) / 6));
  if (last) {
    query[5] = quantize(clamp01(minutesBetweenIso(last.timestamp, tx.requested_at) / 1440));
    query[6] = quantize(clamp01(last.km_from_current / 1000));
  } else {
    query[5] = -10000;
    query[6] = -10000;
  }
  query[7] = quantize(clamp01(terminal.km_from_home / 1000));
  query[8] = quantize(clamp01(customer.tx_count_24h / 20));
  query[9] = terminal.is_online ? 10000 : 0;
  query[10] = terminal.card_present ? 10000 : 0;
  query[11] = merchantIsKnown(customer, merchant.id) ? 0 : 10000;
  query[12] = quantize(mccRisk(merchant.mcc));
  query[13] = quantize(clamp01(merchant.avg_amount / 10000));
  return query;
}

function consider(referenceSet, refIndex, query, bestDist, bestFraud) {
  const buffer = referenceSet.buffer;
  const offset = referenceSet.offsets[refIndex];
  let dist = 0;
  for (let i = 0; i < VECTOR_DIMS; i++) {
    const diff = query[i] - buffer.readInt16LE(offset + i * 2);
    dist += diff * diff;
  }

  let worst = 0;
  for (let i = 1; i < K_NEIGHBORS; i++) {
    if (bestDist[i] > bestDist[worst]) worst = i;
  }
  if (dist < bestDist[worst]) {
    bestDist[worst] = dist;
    bestFraud[worst] = buffer[offset + VECTOR_DIMS * 2];
  }
}

function scanBucket(referenceSet, key, query, bestDist, bestFraud, remaining) {
  let scanned = 0;
  for (let index = referenceSet.heads[key]; index !== -1; index = referenceSet.next[index]) {
    consider(referenceSet, index, query, bestDist, bestFraud);
    scanned++;
    if (scanned >= remaining) break;
  }
  return scanned;
}

function fraudScore(referenceSet, query) {
  const bestDist = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  const bestFraud = [0, 0, 0, 0, 0];
  const amount = bin01(query[0], 32);
  const hour = bin01(query[3], 8);
  const txCount = bin01(query[8], 8);
  const online = query[9] >= 5000 ? 1 : 0;
  const card = query[10] >= 5000 ? 1 : 0;
  const unknown = query[11] >= 5000 ? 1 : 0;
  const mcc = bin01(query[12], 8);
  let scanned = 0;

  for (let radius = 0; radius <= 1; radius++) {
    for (let da = -radius; da <= radius; da++) {
      const ba = amount + da;
      if (ba < 0 || ba >= 32) continue;
      for (let dh = -radius; dh <= radius; dh++) {
        const bh = hour + dh;
        if (bh < 0 || bh >= 8) continue;
        for (let dt = -radius; dt <= radius; dt++) {
          const bt = txCount + dt;
          if (bt < 0 || bt >= 8) continue;
          for (let dm = -radius; dm <= radius; dm++) {
            const bm = mcc + dm;
            if (bm < 0 || bm >= 8) continue;
            if (radius > 0 && da === 0 && dh === 0 && dt === 0 && dm === 0) continue;
            const key = bucketKeyFromBins(ba, bh, bt, online, card, unknown, bm);
            scanned += scanBucket(referenceSet, key, query, bestDist, bestFraud, candidateLimit - scanned);
            if (scanned >= candidateLimit) return scoreFromNeighbors(bestDist, bestFraud);
          }
        }
      }
    }
  }

  if (scanned < 2048) {
    const stride = Math.max(1, Math.floor(referenceSet.count / 4096));
    for (let i = bucketKeyQuery(query) % stride; i < referenceSet.count; i += stride) {
      consider(referenceSet, i, query, bestDist, bestFraud);
    }
  }

  return scoreFromNeighbors(bestDist, bestFraud);
}

function scoreFromNeighbors(bestDist, bestFraud) {
  let frauds = 0;
  let neighbors = 0;
  for (let i = 0; i < K_NEIGHBORS; i++) {
    if (bestDist[i] !== Number.MAX_SAFE_INTEGER) {
      frauds += bestFraud[i] ? 1 : 0;
      neighbors++;
    }
  }
  return neighbors === 0 ? 0 : frauds / neighbors;
}

const references = await loadReferences(referencesPath);
console.error(`rinha-bun listening on :${port} with ${references.count} references`);

Bun.serve({
  port,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ready") {
      return Response.json({ status: "ready" });
    }
    if (request.method !== "POST" || url.pathname !== "/fraud-score") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    try {
      const payload = await request.json();
      const score = fraudScore(references, vectorize(payload));
      return Response.json({
        approved: score < 0.6,
        fraud_score: Math.round(score * 10) / 10,
      });
    } catch {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }
  },
});
