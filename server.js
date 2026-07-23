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
// 管理员密码 + GitHub 自动提交配置
// ══════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'xicha16888-png';
const GITHUB_REPO = process.env.GITHUB_REPO || 'customer-query-system';
const GITHUB_PATH = process.env.GITHUB_PATH || 'customer-list.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ══════════════════════════════════════════
// 历史客户名单（黑名单 / 已结清白名单 / 仍在还款中），静态导入 + 后台手动维护
// customer-list.json 每条记录: { name, idNumber, gender, statusRaw, isBlacklist }
// ══════════════════════════════════════════
let CUSTOMER_LIST = [];
const CUSTOMER_LIST_PATH = path.join(__dirname, 'customer-list.json');
try {
  const raw = fs.readFileSync(CUSTOMER_LIST_PATH, 'utf-8');
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
        isSettled: r.isBlacklist ? null : settled,
        matchType
      });
    }
  }
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
  const legacyPawnUnsettled = legacyMatches.some(m => !m.isBlacklist && m.isSettled === false);

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
  blacklistCount: CUSTOMER_LIST.filter(r => r.isBlacklist).length,
  githubConfigured: !!GITHUB_TOKEN
}));

// ══════════════════════════════════════════
// 管理员：密码验证 + 手动新增/编辑客户 + 自动提交回 GitHub
// ══════════════════════════════════════════
function checkPassword(req, res) {
  const pw = (req.body && req.body.password) || '';
  if (pw !== ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: '密码错误' });
    return false;
  }
  return true;
}

function findExistingIndex(name, idNumber) {
  const qId = idKeyFull(idNumber);
  const qIdNoSuffix = idKeyNoSuffix(idNumber);
  const qName = normName(name);
  if (qId && qId.length >= 6) {
    const idx = CUSTOMER_LIST.findIndex(r => {
      const rid = idKeyFull(r.idNumber);
      const ridNoSuffix = idKeyNoSuffix(r.idNumber);
      return rid === qId || ridNoSuffix === qIdNoSuffix;
    });
    if (idx >= 0) return idx;
  }
  if (qName) {
    const idx = CUSTOMER_LIST.findIndex(r => normName(r.name) === qName);
    if (idx >= 0) return idx;
  }
  return -1;
}

async function commitToGithub() {
  if (!GITHUB_TOKEN) {
    return { ok: false, error: '未配置 GITHUB_TOKEN，本次修改只在服务器内存里生效，重启会丢失' };
  }
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'customer-query-system'
  };
  try {
    // 1) 拿当前文件的 sha
    const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers });
    if (!getRes.ok) throw new Error('读取 GitHub 文件失败: HTTP ' + getRes.status);
    const getData = await getRes.json();
    const sha = getData.sha;

    // 2) 提交更新
    const content = Buffer.from(JSON.stringify(CUSTOMER_LIST, null, 0), 'utf-8').toString('base64');
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '管理面板更新客户名单 ' + new Date().toISOString(),
        content,
        sha,
        branch: GITHUB_BRANCH
      })
    });
    if (!putRes.ok) {
      const errBody = await putRes.text();
      throw new Error('提交 GitHub 失败: HTTP ' + putRes.status + ' ' + errBody);
    }
    return { ok: true };
  } catch (e) {
    console.error('commitToGithub 失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// 查找已有记录，方便添加前先核对是否已存在
app.post('/api/admin/lookup', (req, res) => {
  if (!checkPassword(req, res)) return;
  const name = (req.body.name || '').trim();
  const idNumber = (req.body.idNumber || '').trim();
  const idx = findExistingIndex(name, idNumber);
  if (idx >= 0) {
    res.json({ ok: true, found: true, record: CUSTOMER_LIST[idx] });
  } else {
    res.json({ ok: true, found: false });
  }
});

// 新增或更新一条客户记录
app.post('/api/admin/upsert', async (req, res) => {
  if (!checkPassword(req, res)) return;
  const name = (req.body.name || '').trim();
  const idNumber = (req.body.idNumber || '').trim();
  const gender = (req.body.gender || '').trim();
  const statusRaw = (req.body.statusRaw || '').trim();
  const isBlacklist = !!req.body.isBlacklist;

  if (!name) {
    return res.status(400).json({ ok: false, error: '请填写姓名' });
  }

  const idx = findExistingIndex(name, idNumber);
  const record = { name, idNumber, gender, statusRaw, isBlacklist };
  let action;
  if (idx >= 0) {
    CUSTOMER_LIST[idx] = record;
    action = 'updated';
  } else {
    CUSTOMER_LIST.push(record);
    action = 'added';
  }

  // 本地也存一份（尽力而为，Render 重启会丢，靠 GitHub 提交才是真的持久化）
  try {
    fs.writeFileSync(CUSTOMER_LIST_PATH, JSON.stringify(CUSTOMER_LIST), 'utf-8');
  } catch (e) {
    console.error('本地写入 customer-list.json 失败:', e.message);
  }

  const gitResult = await commitToGithub();

  res.json({
    ok: true,
    action,
    total: CUSTOMER_LIST.length,
    githubCommitted: gitResult.ok,
    githubError: gitResult.ok ? null : gitResult.error
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Customer Cross-Check System');
  console.log('Port: ' + PORT);
  console.log('Customer list records: ' + CUSTOMER_LIST.length);
  console.log('GitHub auto-commit: ' + (GITHUB_TOKEN ? 'enabled' : 'DISABLED (no GITHUB_TOKEN)'));
});
