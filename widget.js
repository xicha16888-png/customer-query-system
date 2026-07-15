/**
 * 客户交叉查询 - 集成小组件
 * 用法：在 MORODOK 或 PAWN 的 index.html 里，"新增合同"提交按钮触发的地方，
 * 在真正保存合同之前先调用 CustomerCheck.confirmBeforeSubmit()，发现风险就弹窗确认。
 * 弹窗文字会跟着宿主页面当前语言（window._lang: 'km'/'en'/其它=中文）自动切换。
 */
(function (global) {
  const QUERY_API_BASE = 'https://customer-query-system.onrender.com'; // 部署后如域名不同请替换

  const MSG = {
    km: {
      crossRisk: (name) => `⚠️ ប្រយ័ត្ន!\n\nអតិថិជន "${name}" មានបំណុលមិនទាន់សងទាំងក្នុងប្រព័ន្ធទូរស័ព្ទបង់រំលស់ និងកម្ចីតូច/បញ្ចាំ!\n\nតើអ្នកនៅតែចង់បន្តដាក់ស្នើកិច្ចសន្យានេះទេ?`,
      otherActive: (name, other) => `ចំណាំ៖ អតិថិជន "${name}" មានបំណុលមិនទាន់សងក្នុងប្រព័ន្ធ【${other}】 តើបន្តដាក់ស្នើទេ?`,
      legacyRisk: (name) => `ចំណាំ៖ អតិថិជន "${name}" ធ្លាប់មានកំណត់ត្រាចាក់សោ/ហួសកាលកំណត់ក្នុងបញ្ជីអតិថិជនចាស់ (គ្មានលម្អិតចំនួនទឹកប្រាក់ ជាព័ត៌មានយោង) តើបន្តដាក់ស្នើទេ?`,
      morodok: 'ទូរស័ព្ទបង់រំលស់', pawn: 'កម្ចីតូច/បញ្ចាំ'
    },
    en: {
      crossRisk: (name) => `⚠️ Risk alert\n\nCustomer "${name}" has unpaid loans in BOTH the Phone Installment and Micro-loan/Pawn systems!\n\nDo you still want to continue submitting this contract?`,
      otherActive: (name, other) => `Note: customer "${name}" has an unpaid loan in the [${other}] system. Continue submitting?`,
      legacyRisk: (name) => `Note: customer "${name}" has a locked/overdue record in the historical list (no amount details, for reference only). Continue submitting?`,
      morodok: 'Phone Installment', pawn: 'Micro-loan/Pawn'
    },
    zh: {
      crossRisk: (name) => `⚠️ 风险提示\n\n客户「${name}」在手机分期和小贷/抵押两个系统均查到未结清贷款！\n\n是否仍要继续提交本次合同？`,
      otherActive: (name, other) => `提示：客户「${name}」在【${other}】系统有未结清贷款，是否继续提交？`,
      legacyRisk: (name) => `提示：客户「${name}」在历史名单中曾有锁机/逾期记录（无金额明细，仅供参考），是否继续提交？`,
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
   * @returns {Promise<boolean>} true = 允许继续提交，false = 用户选择取消
   */
  async function confirmBeforeSubmit(name, phone, idNumber) {
    const data = await checkCustomerCrossSystem(name, phone, idNumber);
    if (!data) return true; // 查询服务不可用时不阻断正常业务

    const lang = currentLang();
    const m = MSG[lang] || MSG.km;

    if (data.crossRisk) {
      return confirm(m.crossRisk(name));
    }
    if (data.morodok.hasActive || data.pawn.hasActive) {
      const other = data.morodok.hasActive ? m.morodok : m.pawn;
      const ok = confirm(m.otherActive(name, other));
      if (!ok) return false;
    }
    if (data.legacyRisk) {
      const ok = confirm(m.legacyRisk(name));
      if (!ok) return false;
    }
    return true;
  }

  global.CustomerCheck = { checkCustomerCrossSystem, confirmBeforeSubmit };
})(window);
