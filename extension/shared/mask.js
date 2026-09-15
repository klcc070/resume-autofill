/**
 * mask.js — 敏感信息脱敏工具
 * 同时运行于:扩展各上下文(挂到 globalThis.Mask)与 Node 单测(module.exports)。
 * 规则:展示/日志/报告中一律使用脱敏值;仅"用户主动点击单个字段"时才临时展示原值。
 */
(function (root) {
  'use strict';

  /** 手机号:保留前 3 后 4,如 138****5678。非 11 位手机号的数字串保留前 3 后 2。 */
  function maskPhone(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const digits = s.replace(/\D/g, '');
    if (digits.length === 11) return digits.slice(0, 3) + '****' + digits.slice(7);
    if (digits.length >= 7) return digits.slice(0, 3) + '****' + digits.slice(-2);
    return '*'.repeat(digits.length);
  }

  /** 邮箱:保留首字符与域名,如 z***@qq.com。 */
  function maskEmail(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const at = s.indexOf('@');
    if (at <= 0) return '*'.repeat(s.length);
    const local = s.slice(0, at);
    return local[0] + '*'.repeat(Math.max(local.length - 1, 3)) + s.slice(at);
  }

  /** 身份证:保留前 4 后 2,如 1101**********12。 */
  function maskIdCard(v) {
    const s = String(v == null ? '' : v).trim().toUpperCase();
    if (!s) return '';
    if (s.length < 8) return '*'.repeat(s.length);
    return s.slice(0, 4) + '*'.repeat(s.length - 6) + s.slice(-2);
  }

  /** 姓名:保留姓氏(首字符),其余打码,如 李*。 */
  function maskName(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (s.length === 1) return s + '*';
    return s[0] + '*'.repeat(s.length - 1);
  }

  /** 敏感字段名 → 脱敏函数 映射。 */
  const SENSITIVE = {
    phone: maskPhone,
    mobile: maskPhone,
    tel: maskPhone,
    email: maskEmail,
    idCard: maskIdCard,
    idNumber: maskIdCard,
    name: maskName,
  };

  /**
   * 按字段路径脱敏。路径示例:"personal.phone" / "personal.email" / "name"。
   * 非敏感字段原样返回。
   */
  function maskValue(fieldPath, value) {
    const leaf = String(fieldPath || '').split('.').pop();
    const fn = SENSITIVE[leaf];
    return fn ? fn(value) : value;
  }

  /** 判断字段路径是否敏感。 */
  function isSensitive(fieldPath) {
    const leaf = String(fieldPath || '').split('.').pop();
    return Object.prototype.hasOwnProperty.call(SENSITIVE, leaf);
  }

  /** 深拷贝一份档案并脱敏所有敏感字段(用于导出/日志)。 */
  function maskProfile(profile) {
    const out = JSON.parse(JSON.stringify(profile || {}));
    const p = out.personal || (out.personal = {});
    if (p.name) p.name = maskName(p.name);
    if (p.phone) p.phone = maskPhone(p.phone);
    if (p.email) p.email = maskEmail(p.email);
    if (p.idCard) p.idCard = maskIdCard(p.idCard);
    if (p.emergencyContactPhone) p.emergencyContactPhone = maskPhone(p.emergencyContactPhone);
    return out;
  }

  const Mask = { maskPhone, maskEmail, maskIdCard, maskName, maskValue, isSensitive, maskProfile };

  root.Mask = Mask;
  if (typeof module !== 'undefined' && module.exports) module.exports = Mask;
})(typeof globalThis !== 'undefined' ? globalThis : this);
