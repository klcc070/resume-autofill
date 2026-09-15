import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// extension 下的 .js 是浏览器脚本(受 package.json type:module 影响不能直接 require),
// 用与浏览器一致的"脚本求值"方式加载,module.exports 守卫使其同时可在 CJS 环境导出。
function loadScript(relPath) {
  const code = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
  const module = { exports: {} };
  const fakeGlobal = {};
  new Function('module', 'exports', 'globalThis', code)(module, module.exports, fakeGlobal);
  return module.exports;
}

const Matcher = loadScript('../../extension/content/matcher.js');
const Mask = loadScript('../../extension/shared/mask.js');

test('normalize: 去空白/标点/必填词', () => {
  assert.equal(Matcher.normalize('  姓 名 ：'), '姓名');
  assert.equal(Matcher.normalize('*手机号码(必填)'), '手机号码');
  assert.equal(Matcher.normalize('E-mail 地址'), 'email地址');
});

test('matchField: 常见中文字段精确匹配', () => {
  assert.equal(Matcher.matchField('姓名', null).path, 'personal.name');
  assert.equal(Matcher.matchField('性别', null).path, 'personal.gender');
  assert.equal(Matcher.matchField('出生年月', null).path, 'personal.birthDate');
  assert.equal(Matcher.matchField('手机号码', null).path, 'personal.phone');
  assert.equal(Matcher.matchField('电子邮箱', null).path, 'personal.email');
  assert.equal(Matcher.matchField('身份证号码', null).path, 'personal.idCard');
  assert.equal(Matcher.matchField('政治面貌', null).path, 'personal.politicalStatus');
  assert.equal(Matcher.matchField('年龄', null).path, 'derived.age');
});

test('matchField: 英文字段', () => {
  assert.equal(Matcher.matchField('Full Name', null).path, 'personal.name');
  assert.equal(Matcher.matchField('Phone Number', null).path, 'personal.phone');
  assert.equal(Matcher.matchField('Email Address', null).path, 'personal.email');
});

test('matchField: 包含匹配与歧义消解', () => {
  // "紧急联系电话" 应命中紧急联系人电话而非普通手机号(精确/更长同义词优先)
  assert.equal(Matcher.matchField('紧急联系电话', null).path, 'personal.emergencyContactPhone');
  // "项目名称" 不应误判为姓名
  assert.notEqual(Matcher.matchField('项目名称', null).path, 'personal.name');
  assert.equal(Matcher.matchField('项目名称', null).path, 'projects[0].name');
  // "意向工作城市(可多选)" 命中城市组
  assert.equal(Matcher.matchField('意向工作城市(可多选)', null).path, 'personal.desiredCities');
});

test('matchField: 行上下文映射到对应数组下标', () => {
  const ctx = { array: 'education', index: 1 };
  assert.equal(Matcher.matchField('学校', ctx).path, 'education[1].school');
  assert.equal(Matcher.matchField('专业', ctx).path, 'education[1].major');
  assert.equal(Matcher.matchField('学历', ctx).path, 'education[1].degree');
  assert.equal(Matcher.matchField('学院名称', ctx).path, 'education[1].college');
  assert.equal(Matcher.matchField('学习形式', ctx).path, 'education[1].fullTime');
  assert.equal(Matcher.matchField('学历类型', ctx).path, 'education[1].fullTime');
  assert.equal(Matcher.matchField('开始时间', ctx).path, 'education[1].startDate');

  const irow = { array: 'internship', index: 0 };
  assert.equal(Matcher.matchField('公司', irow).path, 'internships[0].company');
  assert.equal(Matcher.matchField('职位', irow).path, 'internships[0].role');
  assert.equal(Matcher.matchField('工作内容', irow).path, 'internships[0].description');
  assert.equal(Matcher.matchField('起止时间', irow).path, 'internships[0].startDate');

  const erow = { array: 'employment', index: 1 };
  assert.equal(Matcher.matchField('公司名称', erow).path, 'employment[1].company');
  assert.equal(Matcher.matchField('职位名称', erow).path, 'employment[1].role');

  const prow = { array: 'project', index: 2 };
  assert.equal(Matcher.matchField('项目名称', prow).path, 'projects[2].name');
  assert.equal(Matcher.matchField('担任角色', prow).path, 'projects[2].role');
  assert.equal(Matcher.matchField('项目描述', prow).path, 'projects[2].description');
  assert.equal(Matcher.matchField('项目中职责', prow).path, 'projects[2].role');

  const arow = { array: 'award', index: 1 };
  assert.equal(Matcher.matchField('奖项名称', arow).path, 'awards[1].name');
  assert.equal(Matcher.matchField('获奖时间', arow).path, 'awards[1].date');
  assert.equal(Matcher.matchField('获奖级别', arow).path, 'awards[1].level');
  assert.equal(Matcher.matchField('奖项描述', arow).path, 'awards[1].description');
});

test('matchField: 无行上下文回退到第 0 行', () => {
  assert.equal(Matcher.matchField('毕业院校', null).path, 'education[0].school');
  assert.equal(Matcher.matchField('实习单位', null).path, 'internships[0].company');
  assert.equal(Matcher.matchField('单位名称', { array: 'internship', index: 1 }).path, 'internships[1].company');
  assert.equal(Matcher.matchField('单位介绍', { array: 'internship', index: 1 }), null);
});

test('matchField: 无关字段返回 null', () => {
  assert.equal(Matcher.matchField('招聘信息来源', null), null);
  assert.equal(Matcher.matchField('', null), null);
  assert.equal(Matcher.matchField('验证码', null), null);
});

const profile = {
  personal: { birthDate: '2003-06-15', phone: '13812345678', desiredCities: ['北京'] },
  education: [{ school: '华中科技大学' }],
  internships: [{ company: '云帆科技' }],
  projects: [{ name: '校园平台' }],
  qa: { 是否服从工作地点调剂: '服从调剂', 本人或亲属是否在公司任职: '否' },
};

test('matchQuestion: 筛选题题干匹配 qa', () => {
  assert.deepEqual(
    Matcher.matchQuestion('是否服从全国范围的工作地点调剂?', profile),
    { key: '是否服从工作地点调剂', value: '服从调剂' }
  );
  assert.deepEqual(
    Matcher.matchQuestion('你的本人或亲属是否在本公司任职?', profile),
    { key: '本人或亲属是否在公司任职', value: '否' }
  );
  assert.equal(Matcher.matchQuestion('完全无关的问题?', profile), null);
});

test('matchQuestion: 明确授权的附加问题使用保守默认值，档案答案优先', () => {
  assert.deepEqual(
    Matcher.matchQuestion('本人身体健康，无职业相关禁忌症', {}),
    { key: '本人身体健康，无职业相关禁忌症', value: '是', defaulted: true }
  );
  assert.equal(Matcher.matchQuestion('是否有亲友在芯碁工作', {}).value, '否');
  assert.equal(Matcher.matchQuestion('是否有亲友在芯碁竞业限制企业或上下游关联企业工作', {}).value, '否');
  assert.equal(Matcher.matchQuestion('是否有犯罪记录', {}).value, '否');
  assert.equal(Matcher.matchQuestion('以何种方式了解到公司', {}), null);
  assert.equal(Matcher.matchQuestion('是否有犯罪记录', { qa: { 是否有犯罪记录: '是' } }).value, '是');
});

test('matchField: 亲友与关联企业的条件字段不得误匹配个人或经历数据', () => {
  for (const label of ['亲友姓名', '亲友职位', '关联企业任职亲友姓名', '关联企业名称', '证明人联系方式', '职业相关禁忌症', '犯罪记录说明']) {
    assert.equal(Matcher.matchField(label, null), null, label);
    assert.equal(Matcher.matchField(label, { array: 'internship', index: 0 }), null, `${label} row`);
  }
});

test('optionScore: 选项文本与档案值相似度', () => {
  assert.equal(Matcher.optionScore('男', '男'), 100);
  assert.equal(Matcher.optionScore('CET-6', 'CET-6'), 100);
  assert.ok(Matcher.optionScore('服从调剂', '服从调剂') > Matcher.optionScore('不服从调剂', '服从调剂'));
  assert.equal(Matcher.optionScore('广州', '北京'), 0);
});

// —— mask ——
test('mask: 手机号保留前3后4', () => {
  assert.equal(Mask.maskPhone('13812345678'), '138****5678');
  assert.equal(Mask.maskPhone('138 1234 5678'), '138****5678');
});

test('mask: 邮箱保留首字符与域名', () => {
  assert.equal(Mask.maskEmail('limingyuan@example.com'), 'l*********@example.com');
  assert.equal(Mask.maskEmail('a@b.com'), 'a***@b.com');
});

test('mask: 身份证保留前4后2', () => {
  assert.equal(Mask.maskIdCard('110101200306151234'), '1101************34');
  assert.equal(Mask.maskIdCard('11010120030615123X'), '1101************3X');
});

test('mask: 姓名保留姓氏', () => {
  assert.equal(Mask.maskName('李明远'), '李**');
  assert.equal(Mask.maskName('王'), '王*');
});

test('mask: maskValue 按路径分派', () => {
  assert.equal(Mask.maskValue('personal.phone', '13812345678'), '138****5678');
  assert.equal(Mask.maskValue('personal.idCard', '110101200306151234'), '1101************34');
  assert.equal(Mask.maskValue('education[0].school', '华中科技大学'), '华中科技大学');
});

test('mask: maskProfile 深拷贝脱敏且不改动原对象', () => {
  const p = { personal: { name: '李明远', phone: '13812345678', email: 'a@b.com', idCard: '110101200306151234' } };
  const m = Mask.maskProfile(p);
  assert.equal(m.personal.name, '李**');
  assert.equal(m.personal.phone, '138****5678');
  assert.equal(p.personal.phone, '13812345678'); // 原对象未变
});

test('mask: 空值安全', () => {
  assert.equal(Mask.maskPhone(''), '');
  assert.equal(Mask.maskEmail(null), '');
  assert.equal(Mask.maskIdCard(undefined), '');
  assert.equal(Mask.maskName(''), '');
});
