const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCES = {
  morodok: {
    name: '手机分期 (MORODOK)',
    url: process.env.MORODOK_API || 'https://morodok-system.onrender.com/api/data',
    arrKey: 'sales'
  },
  pawn: {
    name: '小贷/抵押 (PAWN)',
    url: process.env.PAWN_API || 'https://pawn-system.onrender.com/api/data',
    arrKey: 'loans'
  }
};

// ══════════════════════════════════════════
// 历史客户名单（正常 + 黑名单），静态导入
// customer-list.json 每条记录: { name, idNumber, gender, statusRaw, isBlacklist }
// ══════════════════════════════════════════
let CUSTOMER_LIST = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'customer-list.json'), 'utf-8');
  CUSTOMER_LIST = JSON.parse(raw);
  const blCount = CUSTOMER_LIST.filter(r => r.isBlacklist).length;
  console.log(`已加载历史客户名单 ${CUSTOMER_LIST.length} 条（其中黑名单 ${blCount} 条）`);
} catch (e) {
  console.error('加载历史客户名单失败:', e.message);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(__dirname));

const cache = {};
const CACHE_TTL = 30 * 1000;

async function fetchSource(key) {
  const src = SOURCES[key];
  const cached = cache[key];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return { ok: true, records: cached.data, stale: false };
  }
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const records = Array.isArray(json[src.arrKey]) ? json[src.arrKey] : [];
    cache[key] = { data: records, time: Date.now() };
    return { ok: true, records, stale: false };
  } catch (e) {
    console.error(`拉取 ${key} 失败:`, e.message);
    if (cached) return { ok: true, records: cached.data, stale: true };
    return { ok: false, records: [], error: e.message };
  }
}

function normName(n) {
  return (n || '').toString().toUpperCase().trim().replace(/\s+/g, ' ');
}
function phoneKey(p) {
  const digits = (p || '').toString().replace(/\D/g, '');
  return digits.slice(-8);
}
function idKeyFull(v) {
  return (v || '').toString().replace(/\D/g, '');
}
function idKeyNoSuffix(v) {
  return (v || '').toString().replace(/[（(].*?[）)]/g, '').replace(/\D/g, '');
}
function isActive(status) {
  return !/结清/.test(status || '');
}

function summarizeRecord(key, r) {
  if (key === 'morodok') {
    return {
      system: 'morodok',
      id: r.id,
      customer: r.customer || '',
      phone: r.customerPhone || '',
      status: r.status || '',
      active: isActive(r.status),
      date: r.date || '',
      amount: r.installmentAmount != null ? r.installmentAmount : (r.salePrice || ''),
      periods: r.periods || '',
      model: r.modelName || '',
      shop: r.shopName || r.storeName || ''
    };
  }
  return {
    system: 'pawn',
    id: r.id,
    customer: r.customer || '',
    phone: r.customerPhone || '',
    idNumber: r.customerId || '',
    status: r.status || '',
    active: isActive(r.status),
    date: r.date || '',
    amount: r.loanAmount != null ? r.loanAmount : '',
    periods: r.periods || '',
    model: [r.phoneBrand, r.phoneModel].filter(Boolean).join(' '),
    shop: r.shopName || ''
  };
}

function matchRecords(records, key, q) {
  const out = [];
  for (const r of records) {
    const recPhoneKey = phoneKey(r.customerPhone);
    const recNameNorm = normName(r.customer);
    const recIdFull = idKeyFull(r.customerId);
    const recIdNoSuffix = idKeyNoSuffix(r.customerId);
    let matchType = null;
    if (q.phoneKey && recPhoneKey && q.phoneKey.length >= 7 && recPhoneKey === q.phoneKey) {
      matchType = 'phone';
    } else if (q.idFull && recIdFull && q.idFull.length >= 6 && (recIdFull === q.idFull || recIdNoSuffix === q.idNoSuffix)) {
      matchType = 'id';
    } else if (q.nameNorm && recNameNorm && recNameNorm === q.nameNorm) {
      matchType = 'name';
    }
    if (matchType) {
      const s = summarizeRecord(key, r);
      s.matchType = matchType;
      out.push(s);
    }
  }
  out.sort((a, b) => (b.active - a.active));
  return out;
}

function matchCustomerList(q) {
  const out = [];
  for (const r of CUSTOMER_LIST) {
    const recNameNorm = normName(r.name);
    const recIdFull = idKeyFull(r.idNumber);
    const recIdNoSuffix = idKeyNoSuffix(r.idNumber);
    let matchType = null;
    if (q.idFull && recIdFull && q.idFull.length >= 6 && (recIdFull === q.idFull || recIdNoSuffix === q.idNoSuffix)) {
      matchType = 'id';
    } else if (q.nameNorm && recNameNorm && recNameNorm === q.nameNorm) {
      matchType = 'name';
    }
    if (matchType) {
      out.push({
        system: 'legacy',
        customer: r.name,
        idNumber: r.idNumber,
        gender: r.gender,
        statusRaw: r.statusRaw,
        isBlacklist: !!r.isBlacklist,
        matchType
      });
    }
  }
  // 黑名单排前面
  out.sort((a, b) => (b.isBlacklist - a.isBlacklist));
  return out;
}

app.get('/api/check', async (req, res) => {
  const name = (req.query.name || '').trim();
  const phone = (req.query.phone || '').trim();
  const idNumber = (req.query.idNumber || '').trim();
  if (!name && !phone && !idNumber) {
    return res.status(400).json({ ok: false, error: '请至少提供姓名、电话或身份证号其中一项' });
  }
  const q = {
    nameNorm: normName(name),
    phoneKey: phoneKey(phone),
    idFull: idKeyFull(idNumber),
    idNoSuffix: idKeyNoSuffix(idNumber)
  };

  const [morodokRes, pawnRes] = await Promise.all([fetchSource('morodok'), fetchSource('pawn')]);

  const morodokMatches = matchRecords(morodokRes.records, 'morodok', q);
  const pawnMatches = matchRecords(pawnRes.records, 'pawn', q);
  const legacyMatches = matchCustomerList(q);

  const morodokActive = morodokMatches.some(m => m.active);
  const pawnActive = pawnMatches.some(m => m.active);
  const blacklistMatches = legacyMatches.filter(m => m.isBlacklist);
  const blacklistRisk = blacklistMatches.length > 0;

  res.json({
    ok: true,
    query: { name, phone, idNumber },
    morodok: {
      label: SOURCES.morodok.name,
      available: morodokRes.ok,
      stale: !!morodokRes.stale,
      matches: morodokMatches,
      hasActive: morodokActive
    },
    pawn: {
      label: SOURCES.pawn.name,
      available: pawnRes.ok,
      stale: !!pawnRes.stale,
      matches: pawnMatches,
      hasActive: pawnActive
    },
    legacy: {
      count: CUSTOMER_LIST.length,
      available: CUSTOMER_LIST.length > 0,
      matches: legacyMatches
    },
    crossRisk: morodokActive && pawnActive,
    blacklistRisk: blacklistRisk
  });
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  time: new Date().toISOString(),
  customerListCount: CUSTOMER_LIST.length,
  blacklistCount: CUSTOMER_LIST.filter(r => r.isBlacklist).length
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Customer Cross-Check System');
  console.log('Port: ' + PORT);
  console.log('Customer list records: ' + CUSTOMER_LIST.length);
});
