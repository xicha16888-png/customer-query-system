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
// 历史客户名单（黑名单 / 已结清白名单 / 仍在还款中），静态导入，来自手机抵押(PAWN)老客户表
// customer-list.json 每条记录: { name, idNumber, gender, statusRaw, isBlacklist }
// 非黑名单里：statusRaw 含 "end"(不分大小写) = 已结清/真正白名单，两边都能借
//            不含 "end" (含空白) = 当时仍在还款中，不能在手机分期(MORODOK)新增贷款
// ══════════════════════════════════════════
let CUSTOMER_LIST = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'customer-list.json'), 'utf-8');
  CUSTOMER_LIST = JSON.parse(raw);
  const blCount = CUSTOMER_LIST.filter(r => r.isBlacklist).length;
  console.log('已加载历史客户名单 ' + CUSTOMER_LIST.length + ' 条（其中黑名单 ' + blCount + ' 条）');
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
    console.error('拉取 ' + key + ' 失败:', e.message);
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
function isSettledRaw(statusRaw) {
  return /end/i.test(statusRaw || '');
}

// 从还款计划里算逾期：找未还且到期日已过的期次，取逾期最久的一期算天数
function computeOverdue(schedule) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return { isOverdue: false, overdueDays: 0, overdueCount: 0 };
  }
  const now = Date.now();
  let maxDays = 0;
  let count = 0;
  for (const p of schedule) {
    if (p && p.paid !== true && p.dueDate) {
      const due = new Date(p.dueDate).getTime();
      if (!isNaN(due) && due < now) {
        const days = Math.floor((now - due) / 86400000);
        if (days > 0) {
          count++;
          if (days > maxDays) maxDays = days;
        }
      }
    }
  }
  return { isOverdue: maxDays > 0, overdueDays: maxDays, overdueCount: count };
}

function summarizeRecord(key, r) {
  const od = computeOverdue(r.schedule);
  if (key === 'morodok') {
    return {
      system: 'morodok',
      id: r.id,
      customer: r.customer || '',
      phone: r.customerPhone || '',
      status: r.status || '',
      active: isActive(r.status),
      isOverdue: od.isOverdue,
      overdueDays: od.overdueDays,
      overdueCount: od.overdueCount,
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
    isOverdue: od.isOverdue,
    overdueDays: od.overdueDays,
    overdueCount: od.overdueCount,
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
  out.sort((a, b) => (b.overdueDays - a.overdueDays) || (b.active - a.active));
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
      const settled = isSettledRaw(r.statusRaw);
      out.push({
        system: 'legacy',
        customer: r.name,
        idNumber: r.idNumber,
        gender: r.gender,
        statusRaw: r.statusRaw,
        isBlacklist: !!r.isBlacklist,
        // 非黑名单时才有意义：true=已结清(真白名单)，false=当时仍在还款中
        isSettled: r.isBlacklist ? null : settled,
        matchType
      });
    }
  }
  // 黑名单排最前，其次"仍在还款中"的，最后是已结清的
  const weight = m => m.isBlacklist ? 2 : (m.isSettled === false ? 1 : 0);
  out.sort((a, b) => weight(b) - weight(a));
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
  const morodokOverdue = morodokMatches.some(m => m.isOverdue);
  const pawnOverdue = pawnMatches.some(m => m.isOverdue);
  const blacklistMatches = legacyMatches.filter(m => m.isBlacklist);
  const blacklistRisk = blacklistMatches.length > 0;
  // 历史名单里(非黑名单)是否有"当时仍在还款中"的记录 —— 这个名单来自手机抵押(PAWN)老客户表
  const legacyPawnUnsettled = legacyMatches.some(m => !m.isBlacklist && m.isSettled === false);

  // 硬拦截规则：
  // - 黑名单 → 两边都不能借
  // - PAWN 有未结清(实时) 或 历史名单显示仍在还款中 → 不能新增手机分期(MORODOK)
  // - MORODOK 有未结清(实时) → 不能新增小贷/抵押(PAWN)
  const blockMorodok = blacklistRisk || pawnActive || legacyPawnUnsettled;
  const blockPawn = blacklistRisk || morodokActive;

  res.json({
    ok: true,
    query: { name, phone, idNumber },
    morodok: {
      label: SOURCES.morodok.name,
      available: morodokRes.ok,
      stale: !!morodokRes.stale,
      matches: morodokMatches,
      hasActive: morodokActive,
      hasOverdue: morodokOverdue
    },
    pawn: {
      label: SOURCES.pawn.name,
      available: pawnRes.ok,
      stale: !!pawnRes.stale,
      matches: pawnMatches,
      hasActive: pawnActive,
      hasOverdue: pawnOverdue
    },
    legacy: {
      count: CUSTOMER_LIST.length,
      available: CUSTOMER_LIST.length > 0,
      matches: legacyMatches
    },
    crossRisk: morodokActive && pawnActive,
    overdueRisk: morodokOverdue || pawnOverdue,
    blacklistRisk: blacklistRisk,
    legacyPawnUnsettled: legacyPawnUnsettled,
    blockMorodok: blockMorodok,
    blockPawn: blockPawn
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
