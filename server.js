const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════
// 数据源：直接读取两个现有系统的公开只读接口
// 不需要 Supabase 密钥，两个系统的 /api/data 本身就是公开、带 CORS 的接口
// ══════════════════════════════════════════
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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(__dirname));

// ── 简单内存缓存（30秒），避免每次查询都拉取整份数据 ──
const cache = {}; // { morodok: { data, time }, pawn: { data, time } }
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
    if (cached) return { ok: true, records: cached.data, stale: true }; // 用旧缓存兜底
    return { ok: false, records: [], error: e.message };
  }
}

// ── 归一化工具 ──
function normName(n) {
  return (n || '').toString().toUpperCase().trim().replace(/\s+/g, ' ');
}
function phoneKey(p) {
  const digits = (p || '').toString().replace(/\D/g, '');
  return digits.slice(-8); // 取末8位比较，兼容 855/0 前缀差异
}
function isActive(status) {
  // 已结清 / 提前结清 视为非活跃，其余（进行中/逾期/其它）视为活跃
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
  // pawn
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

function matchRecords(records, key, qNameNorm, qPhoneKey) {
  const out = [];
  for (const r of records) {
    const recPhoneKey = phoneKey(r.customerPhone);
    const recNameNorm = normName(r.customer);
    let matchType = null;
    if (qPhoneKey && qPhoneKey.length >= 7 && recPhoneKey === qPhoneKey) {
      matchType = 'phone';
    } else if (qNameNorm && recNameNorm && recNameNorm === qNameNorm) {
      matchType = 'name';
    }
    if (matchType) {
      const s = summarizeRecord(key, r);
      s.matchType = matchType;
      out.push(s);
    }
  }
  // 活跃的排前面
  out.sort((a, b) => (b.active - a.active));
  return out;
}

app.get('/api/check', async (req, res) => {
  const name = (req.query.name || '').trim();
  const phone = (req.query.phone || '').trim();
  if (!name && !phone) {
    return res.status(400).json({ ok: false, error: '请至少提供姓名或电话' });
  }
  const qNameNorm = normName(name);
  const qPhoneKey = phoneKey(phone);

  const [morodokRes, pawnRes] = await Promise.all([fetchSource('morodok'), fetchSource('pawn')]);

  const morodokMatches = matchRecords(morodokRes.records, 'morodok', qNameNorm, qPhoneKey);
  const pawnMatches = matchRecords(pawnRes.records, 'pawn', qNameNorm, qPhoneKey);

  const morodokActive = morodokMatches.some(m => m.active);
  const pawnActive = pawnMatches.some(m => m.active);

  res.json({
    ok: true,
    query: { name, phone },
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
    crossRisk: morodokActive && pawnActive
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(50));
  console.log('  🔎 客户交叉查询系统');
  console.log(`  监听端口: ${PORT}`);
  console.log('═'.repeat(50) + '\n');
});
