/**
 * matcher.js — 字段语义匹配引擎
 * 将表单 label 文本(中英混合)匹配到档案 JSON 路径。
 * 策略参考 resume-auto-fill / JobMatchAI:同义词词典 + 文本归一化 + 精确/包含评分。
 * 无依赖纯 JS,可在 content script(globalThis.Matcher)与 Node 单测中运行。
 */
(function (root) {
  'use strict';

  /** 文本归一化:去空白、常见标点与装饰符,转小写。 */
  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[：:＊*？?！!。,，、;；·（）()\[\]【】<>《》"'""''\-—_~`|/\\]/g, '')
      .replace(/(必填|必填项|请填写|请输入)$/g, '');
  }

  /** 字段类型:filler 据此选择赋值方式 */
  const T = {
    TEXT: 'text', TEL: 'tel', EMAIL: 'email', DATE: 'date', MONTH: 'month',
    NUMBER: 'number', TEXTAREA: 'textarea', SELECT: 'select', RADIO: 'radio',
    CHECKBOX_GROUP: 'checkbox-group', CUSTOM_SELECT: 'custom-select', CUSTOM_PICKER: 'custom-picker',
  };

  // 条件性第三方信息不能退化成“姓名、公司、职位”等简历字段。
  const CONTEXT_ONLY_FIELDS = [
    /^(?:亲友|关联企业任职亲友|证明人)(?:姓名|职位|岗位|联系方式|联系电话|电话)$/,
    /^关联企业名称$/,
    /^以何种方式了解到公司$/,
    /^(?:职业相关禁忌症|犯罪记录说明)$/,
  ];

  /**
   * 主词典:全局/个人信息字段。
   * type 省略时按 TEXT 处理;valueMap 用于把档案值改写为表单选项文本。
   */
  const GLOBAL_DICT = [
    { path: 'personal.name', synonyms: ['姓名', '名字', '真实姓名', '您的姓名', '学生姓名', '候选人姓名', 'name', 'fullname', 'yourname'] },
    { path: 'personal.gender', synonyms: ['性别', 'gender', 'sex'], type: T.RADIO },
    { path: 'personal.birthDate', synonyms: ['出生年月', '出生日期', '出生年月日', '生日', 'birthdate', 'dateofbirth', 'birthday'], type: T.DATE },
    { path: 'derived.age', synonyms: ['年龄', '周岁', 'age'], type: T.NUMBER },
    { path: 'personal.phone', synonyms: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', 'mobile', 'phone', 'tel', 'phonenumber'], type: T.TEL },
    { path: 'personal.email', synonyms: ['邮箱', '电子邮箱', '电子邮件', 'emailaddress', 'email', 'email邮箱', 'mail'], type: T.EMAIL },
    { path: 'personal.idCard', synonyms: ['身份证', '身份证号', '身份证号码', '身份证件号', '证件号码', 'idnumber', 'idcard'], type: T.TEXT },
    { path: 'personal.politicalStatus', synonyms: ['政治面貌', '政治状态', 'politicalstatus'], type: T.SELECT },
    { path: 'personal.ethnicity', synonyms: ['民族', 'ethnicity'], type: T.SELECT },
    { path: 'personal.origin', synonyms: ['籍贯', '生源地', '生源地区', 'origin'], type: T.TEXT },
    { path: 'personal.hukou', synonyms: ['户口所在地', '户籍所在地', '户口', '户籍', '户口所在城市', '户籍地'], type: T.TEXT },
    { path: 'personal.address', synonyms: ['现居住地', '居住地址', '通讯地址', '现居城市', '通信地址', '地址', 'address'], type: T.TEXT },
    { path: 'personal.englishLevel', synonyms: ['英语等级', '英语水平', '英语能力', '四六级', 'cet', 'englishlevel'], type: T.SELECT },
    { path: 'personal.gpa', synonyms: ['gpa', '绩点', '平均绩点', 'gpa成绩'], type: T.TEXT },
    { path: 'personal.expectedSalary', synonyms: ['期望薪资', '期望月薪', '期望薪酬', '薪资期望', 'expectedsalary'], type: T.TEXT },
    { path: 'personal.desiredCities', synonyms: ['意向工作城市', '意向城市', '期望工作城市', '期望工作地点', '意向工作地点', '期望城市', '工作地点意向', 'preferredcities'], type: T.CHECKBOX_GROUP },
    { path: 'personal.website', synonyms: ['个人主页', '个人网站', '个人网址', 'website', 'homepage'], type: T.URL },
    { path: 'personal.github', synonyms: ['github', 'github地址', 'github账号'], type: T.URL },
    { path: 'personal.emergencyContact', synonyms: ['紧急联系人', 'emergencycontact'], type: T.TEXT },
    { path: 'personal.emergencyContactPhone', synonyms: ['紧急联系电话', '紧急联系人电话', '紧急联系方式'], type: T.TEL },
    { path: 'summary.selfIntroduction', synonyms: ['自我评价', '自我介绍', '个人评价', '个人介绍', 'selfintroduction', 'aboutme'], type: T.TEXTAREA },
  ];

  /**
   * 经历行词典:按 rowContext.array 选择。
   * path 中 {i} 由 scanner/filler 替换为行下标;无行上下文时默认 0。
   */
  const ROW_DICTS = {
    education: [
      { path: 'education[{i}].school', synonyms: ['学校', '院校', '毕业学校', '毕业院校', '学校名称', '所在学校', '学校院校', 'school', 'university'], type: T.TEXT },
      { path: 'education[{i}].college', synonyms: ['学院', '学院名称', '所在学院', '院系', '院系名称', 'college', 'faculty'], type: T.TEXT },
      { path: 'education[{i}].major', synonyms: ['专业', '专业名称', '所学专业', '主修专业', 'major'], type: T.TEXT },
      { path: 'education[{i}].degree', synonyms: ['学历', '学位', '学历层次', ' degree', 'degree'], type: T.SELECT },
      { path: 'education[{i}].fullTime', synonyms: ['全日制', '非全日制', '学习形式', '就读形式', '培养方式', '学历类型', '教育类型', 'fulltime', 'full-time', 'studytype', 'studymode', 'educationtype'], type: T.RADIO },
      { path: 'education[{i}].startDate', synonyms: ['开始时间', '入学时间', '就读时间', '起始时间', '起止时间从', '从', 'startdate', 'from'], type: T.MONTH },
      { path: 'education[{i}].endDate', synonyms: ['结束时间', '毕业时间', '截止时间', '至今', '至', 'enddate', 'to'], type: T.MONTH },
    ],
    internship: [
      { path: 'internships[{i}].company', synonyms: ['公司', '单位', '单位名称', '公司名称', '企业', '实习单位', '实习公司', '所在单位', '雇主', 'company'], type: T.TEXT },
      { path: 'internships[{i}].role', synonyms: ['职位', '岗位', '实习岗位', '职位名称', '担任职位', '实习职位', 'role', 'position'], type: T.TEXT },
      { path: 'internships[{i}].department', synonyms: ['部门', '所在部门', '实习部门', 'department'], type: T.TEXT },
      { path: 'internships[{i}].startDate', synonyms: ['开始时间', '起止时间', '入职时间', '起始时间', '从', 'startdate'], type: T.MONTH },
      { path: 'internships[{i}].endDate', synonyms: ['结束时间', '离职时间', '截止时间', '至', 'enddate'], type: T.MONTH },
      { path: 'internships[{i}].description', synonyms: ['工作内容', '实习内容', '工作描述', '实习描述', '职责描述', '内容描述', '工作职责', 'description'], type: T.TEXTAREA },
    ],
    employment: [
      { path: 'employment[{i}].company', synonyms: ['公司', '单位', '公司名称', '企业', '工作单位', '任职公司', '雇主', 'company', 'employer'], type: T.TEXT },
      { path: 'employment[{i}].role', synonyms: ['职位', '岗位', '职位名称', '担任职位', '工作岗位', 'role', 'position', 'title'], type: T.TEXT },
      { path: 'employment[{i}].department', synonyms: ['部门', '所在部门', '任职部门', 'department'], type: T.TEXT },
      { path: 'employment[{i}].startDate', synonyms: ['开始时间', '起止时间', '入职时间', '起始时间', '从', 'startdate'], type: T.MONTH },
      { path: 'employment[{i}].endDate', synonyms: ['结束时间', '离职时间', '截止时间', '至', 'enddate'], type: T.MONTH },
      { path: 'employment[{i}].description', synonyms: ['工作内容', '工作描述', '职责描述', '内容描述', '工作职责', 'description'], type: T.TEXTAREA },
    ],
    project: [
      { path: 'projects[{i}].name', synonyms: ['项目名称', '项目名', '项目', '作品名称', '实践名称', 'projectname'], type: T.TEXT },
      { path: 'projects[{i}].role', synonyms: ['担任角色', '项目角色', '项目中职责', '项目职责', '角色', '承担角色', '职责角色', 'role'], type: T.TEXT },
      { path: 'projects[{i}].startDate', synonyms: ['开始时间', '起止时间', '起始时间', '从', 'startdate'], type: T.MONTH },
      { path: 'projects[{i}].endDate', synonyms: ['结束时间', '截止时间', '至', 'enddate'], type: T.MONTH },
      { path: 'projects[{i}].techStack', synonyms: ['技术栈', '使用技术', '技术选型', 'techstack'], type: T.TEXT },
      { path: 'projects[{i}].description', synonyms: ['项目描述', '项目介绍', '内容简介', '项目内容', '实践描述', 'description'], type: T.TEXTAREA },
    ],
    award: [
      { path: 'awards[{i}].name', synonyms: ['奖项', '奖项名称', '获奖名称', '奖励名称', 'award', 'awardname'], type: T.TEXT },
      { path: 'awards[{i}].date', synonyms: ['获奖时间', '获奖日期', '奖励时间', '授予时间', 'awarddate', 'awardtime'], type: T.MONTH },
      { path: 'awards[{i}].level', synonyms: ['获奖级别', '奖励级别', '奖项级别', '级别', 'awardlevel', 'level'], type: T.SELECT },
      { path: 'awards[{i}].description', synonyms: ['奖项描述', '获奖描述', '奖励描述', '奖项说明', '获奖情况', 'description'], type: T.TEXTAREA },
    ],
  };

  /** 预归一化词典,加快匹配并统一长度比较 */
  const GLOBAL_NORM = GLOBAL_DICT.map((e) => ({
    path: e.path,
    type: e.type || T.TEXT,
    syn: e.synonyms.map(normalize),
  }));
  const ROW_NORM = {};
  for (const key of Object.keys(ROW_DICTS)) {
    ROW_NORM[key] = ROW_DICTS[key].map((e) => ({
      path: e.path,
      type: e.type || T.TEXT,
      syn: e.synonyms.map(normalize),
    }));
  }

  const EXACT_SCORE = 100;
  const CONTAIN_BASE = 80;
  const MIN_SCORE = 50;

  /**
   * 在一个(已归一化的)词条集合中为 label 找最佳匹配。
   * 返回 { path, type, score, synonym } 或 null。
   */
  function bestMatch(normLabel, entries) {
    let best = null;
    for (const e of entries) {
      for (const s of e.syn) {
        if (!s) continue;
        let score = 0;
        if (normLabel === s) {
          score = EXACT_SCORE + s.length; // 精确命中:越长越可信
        } else if (normLabel.includes(s)) {
          score = CONTAIN_BASE + s.length - (normLabel.length - s.length);
        } else if (s.includes(normLabel) && normLabel.length >= 2) {
          score = CONTAIN_BASE + normLabel.length - (s.length - normLabel.length) * 2;
        }
        if (score >= MIN_SCORE && (!best || score > best.score)) {
          best = { path: e.path, type: e.type, score, synonym: s };
        }
      }
    }
    return best;
  }

  /**
   * 匹配一个字段。
   * @param {string} labelText  字段 label 文本
   * @param {{array: string, index: number}|null} rowContext 经历行上下文
   * @returns {{path: string, type: string, score: number, row: boolean}|null}
   */
  function matchField(labelText, rowContext) {
    const norm = normalize(labelText);
    if (!norm) return null;
    if (CONTEXT_ONLY_FIELDS.some((pattern) => pattern.test(norm))) return null;
    if (rowContext && ROW_NORM[rowContext.array]) {
      // “单位介绍/公司简介”是单位说明，不是单位名称；避免短词“单位/公司”把它挤进 company。
      if ((rowContext.array === 'internship' || rowContext.array === 'internships' || rowContext.array === 'employment') && /介绍|简介/.test(norm)) return null;
      const hit = bestMatch(norm, ROW_NORM[rowContext.array]);
      if (hit) {
        hit.path = hit.path.replace('{i}', String(rowContext.index || 0));
        hit.row = true;
        return hit;
      }
      return null;
    }
    const hit = bestMatch(norm, GLOBAL_NORM);
    if (hit) {
      hit.row = false;
      return hit;
    }
    // 全局词典未命中时,回退到各经历行词典的第 0 行(处理未识别出行容器的单组经历字段)
    let fallback = null;
    for (const key of Object.keys(ROW_NORM)) {
      const h = bestMatch(norm, ROW_NORM[key]);
      if (/介绍|简介/.test(norm) && /^(internships|employment)\[/.test(h?.path || '') && /\.company$/.test(h?.path || '')) continue;
      if (h && (!fallback || h.score > fallback.score)) {
        h.path = h.path.replace('{i}', '0');
        h.row = true;
        h.array = key;
        fallback = h;
      }
    }
    return fallback;
  }

  /** 字符级有序子序列判断(key 的每个字符按顺序出现在 text 中)。 */
  function isSubsequence(key, text) {
    let i = 0;
    for (let j = 0; j < text.length && i < key.length; j++) {
      if (text[j] === key[i]) i += 1;
    }
    return i === key.length;
  }

  /**
   * 筛选题匹配:题干与 profile.qa 的键互包含即命中;
   * 包含失败时退化为有序子序列匹配(容忍题干插入修饰语,如"全国范围的")。
   * @returns {{key: string, value: string}|null}
   */
  function matchQuestion(questionText, profile) {
    const normQ = normalize(questionText);
    if (!normQ || !profile) return null;
    let best = null;
    for (const key of Object.keys(profile.qa || {})) {
      const normK = normalize(key);
      if (!normK) continue;
      let score = 0;
      if (normQ === normK) score = 200;
      else if (normQ.includes(normK)) score = 100 + normK.length;
      else if (normK.includes(normQ)) score = 80 + normQ.length;
      else if (normK.length >= 6 && isSubsequence(normK, normQ)) score = 40 + normK.length;
      if (score > 0 && (!best || score > best.score)) {
        best = { key, value: String(profile.qa[key]), score };
      }
    }
    if (best) return { key: best.key, value: best.value };

    // 仅为用户明确授权、答案无歧义的合规题提供保守默认值。
    // profile.qa 始终优先，因此用户可覆盖任意默认答案。
    const defaults = [
      {
        key: '是否有亲友在竞业限制企业或上下游关联企业工作',
        value: '否',
        pattern: /是否.*(?:亲友|亲属).*(?:竞业限制|上下游|关联企业).*工作/,
      },
      {
        key: '是否有亲友在公司工作',
        value: '否',
        pattern: /是否.*(?:亲友|亲属).*(?:本公司|公司|单位|芯碁).*工作/,
      },
      {
        key: '本人身体健康，无职业相关禁忌症',
        value: '是',
        pattern: /(?:身体健康.*无.*(?:职业)?相关?禁忌症|无.*(?:职业)?相关?禁忌症.*身体健康)/,
      },
      {
        key: '是否有犯罪记录',
        value: '否',
        pattern: /是否.*有?犯罪记录/,
      },
    ];
    const fallback = defaults.find((item) => item.pattern.test(normQ));
    return fallback ? { key: fallback.key, value: fallback.value, defaulted: true } : null;
  }

  /** 候选选项文本与档案值的相似度(供 filler 对 radio/select/checkbox 选选项)。 */
  function optionScore(optionText, profileValue) {
    const o = normalize(optionText);
    const v = normalize(profileValue);
    if (!o || !v) return 0;
    if (o === v) return 100;
    if (o.includes(v) || v.includes(o)) return 80;
    return 0;
  }

  const Matcher = { normalize, matchField, matchQuestion, optionScore, T, GLOBAL_DICT, ROW_DICTS };

  root.Matcher = Matcher;
  if (typeof module !== 'undefined' && module.exports) module.exports = Matcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
