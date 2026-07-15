/**
 * 客户交叉查询 - 集成小组件
 * 用法：在 MORODOK 或 PAWN 的 index.html 里，"新增合同"提交按钮触发的地方，
 * 在真正保存合同之前先调用 checkCustomerCrossSystem()，如果发现风险就弹窗确认。
 *
 * 引入方式（二选一）：
 * 1) <script src="https://你的客户查询系统域名.onrender.com/widget.js"></script>
 * 2) 直接把下面这段函数复制进现有 index.html 的 <script> 里
 */
(function (global) {
  const QUERY_API_BASE = 'https://你的客户查询系统域名.onrender.com'; // 部署后替换成实际地址

  /**
   * 查询客户是否在另一系统有未结清贷款
   * @param {string} name  客户姓名
   * @param {string} phone 客户电话
   * @returns {Promise<{crossRisk:boolean, morodok:object, pawn:object}|null>} null 表示查询失败（不阻断流程）
   */
  async function checkCustomerCrossSystem(name, phone) {
    try {
      const params = new URLSearchParams();
      if (name) params.set('name', name);
      if (phone) params.set('phone', phone);
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
   * 在提交新合同前调用：弹出确认框，员工可选择"仍然继续"或"取消"
   * @returns {Promise<boolean>} true = 允许继续提交，false = 用户选择取消
   */
  async function confirmBeforeSubmit(name, phone) {
    const data = await checkCustomerCrossSystem(name, phone);
    if (!data) return true; // 查询服务不可用时不阻断正常业务

    if (data.crossRisk) {
      return confirm(
        `⚠️ 风险提示\n\n客户「${name}」在手机分期和小贷/抵押两个系统均查到未结清贷款！\n\n` +
        `是否仍要继续提交本次合同？`
      );
    }
    if (data.morodok.hasActive || data.pawn.hasActive) {
      const other = data.morodok.hasActive ? '手机分期' : '小贷/抵押';
      return confirm(`提示：客户「${name}」在【${other}】系统有未结清贷款，是否继续提交？`);
    }
    return true;
  }

  global.CustomerCheck = { checkCustomerCrossSystem, confirmBeforeSubmit };
})(window);
