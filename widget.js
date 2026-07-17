/**
 * 客户交叉查询 - 集成小组件
 * 用法：在 MORODOK 或 PAWN 的 index.html 里，"新增合同"提交按钮触发的地方，
 * 在真正保存合同之前先调用 CustomerCheck.confirmBeforeSubmit()。
 *
 * 黑名单客户 = 硬拦截，直接 alert 报警并阻止提交，没有"仍要继续"的选项。
 * 其它风险（两边都有未结清贷款等）= 软性确认，员工可以选择继续或取消。
 * 弹窗文字跟着宿主页面当前语言（window._lang: 'km'/'en'/其它=中文）自动切换。
 */
(function (global) {
  const QUERY_API_BASE = 'https://customer-query-system.onrender.com'; // 部署后如域名不同请替换

  const MSG = {
    km: {
      blacklist: (name) => `🚨 បញ្ឈប់! អតិថិជន "${name}" ស្ថិតក្នុងបញ្ជីខ្មៅ!\n\nហាមឃាត់មិនឱ្យខ្ចីលុយ ឬធ្វើប័ណ្ណបង់រំលស់ទូរស័ព្ទឱ្យអតិថិជននេះដាច់ខាត។\nការដាក់ស្នើនេះត្រូវបានបញ្ឈប់ដោយស្វ័យប្រវត្តិ។`,
      crossRisk: (name) => `⚠️ ប្រយ័ត្ន!\n\nអតិថិជន "${name}" មានបំណុលមិនទាន់សងទាំងក្នុងប្រព័ន្ធទូរស័ព្ទបង់រំលស់ និងកម្ចីតូច/បញ្ចាំ!\n\nតើអ្នកនៅតែចង់បន្តដាក់ស្នើកិច្ចសន្យានេះទេ?`,
      otherActive: (name, other) => `ចំណាំ៖ អតិថិជន "${name}" មានបំណុលមិនទាន់សងក្នុងប្រព័ន្ធ【${other}】 តើបន្តដាក់ស្នើទេ?`,
      morodok: 'ទូរស័ព្ទបង់រំលស់', pawn: 'កម្ចីតូច/បញ្ចាំ'
    },
    en: {
      blacklist: (name) => `🚨 BLOCKED! Customer "${name}" is on the BLACKLIST!\n\nLending or phone installment is strictly forbidden for this customer.\nThis submission has been automatically blocked.`,
      crossRisk: (name) => `⚠️ Risk alert\n\nCustomer "${name}" has unpaid loans in BOTH the Phone Installment and Micro-loan/Pawn systems!\n\nDo you still want to continue submitting this contract?`,
      otherActive: (name, other) => `Note: customer "${name}" has an unpaid loan in the [${other}] system. Continue submitting?`,
      morodok: 'Phone Installment', pawn: 'Micro-loan/Pawn'
    },
    zh: {
      blacklist: (name) => `🚨 已阻止！客户「${name}」在黑名单中！\n\n严禁向该客户放款或办理手机分期。\n本次提交已被自动拦截。`,
      crossRisk: (name) => `⚠️ 风险提示\n\n客户「${name}」在手机分期和小贷/抵押两个系统均查到未结清贷款！\n\n是否仍要继续提交本次合同？`,
      otherActive: (name, other) => `提示：客户「${name}」在【${other}】系统有未结清贷款，是否继续提交？`,
      morodok: '手机分期', pawn: '小贷/抵押'
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
   * @returns {Promise<boolean>} true = 允许继续提交，false = 阻止提交（黑名单硬拦截，或员工手动取消）
   */
  async function confirmBeforeSubmit(name, phone, idNumber) {
    const data = await checkCustomerCrossSystem(name, phone, idNumber);
    if (!data) return true; // 查询服务不可用时不阻断正常业务（查不到不代表有问题）

    const lang = currentLang();
    const m = MSG[lang] || MSG.km;

    // 🚨 黑名单：硬拦截，没有"仍要继续"的选项
    if (data.blacklistRisk) {
      alert(m.blacklist(name));
      return false;
    }

    if (data.crossRisk) {
      return confirm(m.crossRisk(name));
    }
    if (data.morodok.hasActive || data.pawn.hasActive) {
      const other = data.morodok.hasActive ? m.morodok : m.pawn;
      const ok = confirm(m.otherActive(name, other));
      if (!ok) return false;
    }
    return true;
  }

  global.CustomerCheck = { checkCustomerCrossSystem, confirmBeforeSubmit };
})(window);
