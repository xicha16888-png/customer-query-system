/**
 * 客户交叉查询 - 集成小组件
 * 用法：在 MORODOK 或 PAWN 的 index.html 里，"新增合同"提交按钮触发的地方，
 * 在真正保存合同之前先调用 CustomerCheck.confirmBeforeSubmit()，发现风险就弹窗确认。
 */
(function (global) {
  const QUERY_API_BASE = 'https://customer-query-system.onrender.com'; // 部署后如域名不同请替换

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

    if (data.crossRisk) {
      return confirm(
        `⚠️ 风险提示\n\n客户「${name}」在手机分期和小贷/抵押两个系统均查到未结清贷款！\n\n是否仍要继续提交本次合同？`
      );
    }
    if (data.morodok.hasActive || data.pawn.hasActive) {
      const other = data.morodok.hasActive ? '手机分期' : '小贷/抵押';
      const ok = confirm(`提示：客户「${name}」在【${other}】系统有未结清贷款，是否继续提交？`);
      if (!ok) return false;
    }
    if (data.legacyRisk) {
      const ok = confirm(`提示：客户「${name}」在历史名单中曾有锁机/逾期记录（无金额明细，仅供参考），是否继续提交？`);
      if (!ok) return false;
    }
    return true;
  }

  global.CustomerCheck = { checkCustomerCrossSystem, confirmBeforeSubmit };
})(window);
