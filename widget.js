/**
 * 客户交叉查询 - 集成小组件
 *
 * 用法：在 MORODOK 或 PAWN 的"新增合同"提交函数里，真正保存之前调用：
 *   const ok = await CustomerCheck.confirmBeforeSubmit(cust, custPhone, custIdNumber, 'morodok');  // PAWN那边传 'pawn'
 *   if (!ok) return;
 *
 * 硬拦截规则（没有"仍要继续"的选项，直接 alert 报警并阻止提交）：
 *   - 黑名单客户 → 两边都拦截
 *   - 客户在 PAWN(小贷/抵押) 有未结清贷款（实时数据，或历史名单显示当时仍在还款中）→ 拦截 MORODOK(手机分期) 新增
 *   - 客户在 MORODOK(手机分期) 有未结清贷款（实时数据）→ 拦截 PAWN(小贷/抵押) 新增
 *
 * 弹窗文字跟着宿主页面当前语言（window._lang: 'km'/'en'/其它=中文）自动切换。
 */
(function (global) {
  const QUERY_API_BASE = 'https://customer-query-system.onrender.com'; // 部署后如域名不同请替换

  const MSG = {
    km: {
      blacklist: (name) => `🚨 បញ្ឈប់! អតិថិជន "${name}" ស្ថិតក្នុងបញ្ជីខ្មៅ!\n\nហាមឃាត់មិនឱ្យខ្ចីលុយ ឬធ្វើប័ណ្ណបង់រំលស់ទូរស័ព្ទឱ្យអតិថិជននេះដាច់ខាត។\nការដាក់ស្នើនេះត្រូវបានបញ្ឈប់ដោយស្វ័យប្រវត្តិ។`,
      blockMorodok: (name) => `🚫 បញ្ឈប់! អតិថិជន "${name}" មានបំណុលមិនទាន់សងក្នុងប្រព័ន្ធកម្ចីតូច/បញ្ចាំ (PAWN)!\n\nមិនអាចធ្វើប័ណ្ណបង់រំលស់ទូរស័ព្ទថ្មីឱ្យអតិថិជននេះបានទេ រហូតដល់បំណុលចាស់ត្រូវបានទូទាត់រួច។\nការដាក់ស្នើនេះត្រូវបានបញ្ឈប់ដោយស្វ័យប្រវត្តិ។`,
      blockPawn: (name) => `🚫 បញ្ឈប់! អតិថិជន "${name}" មានបំណុលមិនទាន់សងក្នុងប្រព័ន្ធទូរស័ព្ទបង់រំលស់ (MORODOK)!\n\nមិនអាចផ្តល់កម្ចីតូច/បញ្ចាំថ្មីឱ្យអតិថិជននេះបានទេ រហូតដល់បំណុលចាស់ត្រូវបានទូទាត់រួច។\nការដាក់ស្នើនេះត្រូវបានបញ្ឈប់ដោយស្វ័យប្រវត្តិ។`
    },
    en: {
      blacklist: (name) => `🚨 BLOCKED! Customer "${name}" is on the BLACKLIST!\n\nLending or phone installment is strictly forbidden for this customer.\nThis submission has been automatically blocked.`,
      blockMorodok: (name) => `🚫 BLOCKED! Customer "${name}" has an unpaid loan in the Micro-loan/Pawn (PAWN) system!\n\nA new phone installment cannot be issued to this customer until the existing loan is settled.\nThis submission has been automatically blocked.`,
      blockPawn: (name) => `🚫 BLOCKED! Customer "${name}" has an unpaid loan in the Phone Installment (MORODOK) system!\n\nA new micro-loan/pawn cannot be issued to this customer until the existing loan is settled.\nThis submission has been automatically blocked.`
    },
    zh: {
      blacklist: (name) => `🚨 已阻止！客户「${name}」在黑名单中！\n\n严禁向该客户放款或办理手机分期。\n本次提交已被自动拦截。`,
      blockMorodok: (name) => `🚫 已阻止！客户「${name}」在小贷/抵押(PAWN)系统有未结清贷款！\n\n在旧贷款结清之前，不能给该客户新增手机分期。\n本次提交已被自动拦截。`,
      blockPawn: (name) => `🚫 已阻止！客户「${name}」在手机分期(MORODOK)系统有未结清贷款！\n\n在旧贷款结清之前，不能给该客户新增小贷/抵押。\n本次提交已被自动拦截。`
    }
  };

  function currentLang() {
    try {
      if (typeof _lang !== 'undefined' && (_lang === 'km' || _lang === 'en' || _lang === 'zh')) return _lang;
    } catch (e) {}
    return 'km';
  }

  async function checkCustomerCrossSystem(name, phone, idNumber) {
    try {
      const params = new URLSearchParams();
      if (name) params.set('name', name);
      if (phone) params.set('phone', phone);
      if (idNumber) params.set('idNumber', idNumber);
      const res = await fetch(`${QUERY_API_BASE}/api/check?${params.toString()}`, {
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      return data.ok ? data : null;
    } catch (e) {
      console.warn('客户交叉查询失败（不阻断流程）:', e.message);
      return null;
    }
  }

  /**
   * 在提交新合同前调用
   * @param {string} name
   * @param {string} phone
   * @param {string} idNumber 可选，PAWN那边有身份证号字段的话传进来
   * @param {'morodok'|'pawn'} hostSystem 当前是哪个系统在调用（决定拦截方向）
   * @returns {Promise<boolean>} true = 允许继续提交，false = 阻止提交
   */
  async function confirmBeforeSubmit(name, phone, idNumber, hostSystem) {
    const data = await checkCustomerCrossSystem(name, phone, idNumber);
    if (!data) return true; // 查询服务不可用时不阻断正常业务

    const lang = currentLang();
    const m = MSG[lang] || MSG.km;

    if (data.blacklistRisk) {
      alert(m.blacklist(name));
      return false;
    }
    if (hostSystem === 'morodok' && data.blockMorodok) {
      alert(m.blockMorodok(name));
      return false;
    }
    if (hostSystem === 'pawn' && data.blockPawn) {
      alert(m.blockPawn(name));
      return false;
    }
    return true;
  }

  global.CustomerCheck = { checkCustomerCrossSystem, confirmBeforeSubmit };
})(window);
