'use strict';
/* 乐恩报道管理系统 前端（零依赖） */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') n[k] = !!v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) { if (kid === null || kid === undefined) continue; n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return n;
}
let ME = null, VER = '';
window.addEventListener('error', e => {
  const m = String(e && e.message || '');
  if (/is not defined|Cannot read|null|undefined/i.test(m)) toast('页面组件加载异常，请按 Ctrl+F5 强制刷新一次', true);
});
window.addEventListener('unhandledrejection', e => {
  const m = String(e && e.reason && e.reason.message || e.reason || '');
  if (/is not defined|Cannot read|show is not/i.test(m)) toast('页面组件加载异常，请按 Ctrl+F5 强制刷新一次', true);
  console.error('[lenen] 异步错误:', e.reason);
});
/* 切页清理钩子：页面注册资源释放函数（如摄像头），route() 切页时执行 */
let pageCleanup = null;
/* 顶部加载条：任何请求进行中都会显示（弱网反馈） */
let inflight = 0;
function loadbar(on2) {
  inflight += on2 ? 1 : -1;
  if (inflight < 0) inflight = 0;
  let b = $('#loadbar');
  if (!b) { b = el('div', { id: 'loadbar' }, el('i')); document.body.append(b); }
  b.classList.toggle('on', inflight > 0);
}
async function api(path, body, method) {
  const m = method || (body ? 'POST' : 'GET');
  const opt = { method: m, headers: {}, signal: AbortSignal.timeout(15000) };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.headers['X-Req-Id'] = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    opt.body = JSON.stringify(body);
  }
  const act = typeof document !== 'undefined' ? document.activeElement : null;
  const btn = m === 'POST' && act && /^(BUTTON|SL-BUTTON)$/i.test(act.tagName) && !act.disabled ? act : null;
  if (btn) { btn.disabled = true; try { if (btn.tagName === 'SL-BUTTON') btn.loading = true; } catch {} }
  loadbar(true);
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    loadbar(false);
    if (btn) { btn.disabled = false; try { if (btn.tagName === 'SL-BUTTON') btn.loading = false; } catch {} }
    throw new Error('网络连接超时或不稳定，请检查网络后重试');
  }
  loadbar(false);
  if (btn) { btn.disabled = false; try { if (btn.tagName === 'SL-BUTTON') btn.loading = false; } catch {} }
  if (r.headers.get('content-type')?.includes('json')) {
    const j = await r.json();
    if (!r.ok) {
      if (r.status === 401 && ME) { location.reload(); return new Promise(() => {}); } // 会话过期：自动回登录页（登录页自身 401 不受影响）
      throw new Error(j.error || ('请求未成功（状态码 ' + r.status + '）'));
    }
    return j;
  }
  if (!r.ok) throw new Error('服务响应异常（状态码 ' + r.status + '），请稍后重试');
  return r;
}
function toast(msg, bad) {
  const t = el('div', { class: (bad ? 'bad ' : '') + 'animate__animated animate__fadeInUp' }, msg);
  $('#toast').append(t);
  setTimeout(() => { t.classList.remove('animate__fadeInUp'); t.classList.add('animate__fadeOut'); setTimeout(() => t.remove(), 400); }, bad ? 5000 : 2600);
}
/* 统一确认弹窗（sl-dialog 实现，接口不变） */
function askConfirm(title, text, opts) {
  opts = opts || {};
  try {
    if (!customElements.get('sl-dialog')) throw new Error('component not ready');
    return new Promise(resolve => {
      const cancel = el('sl-button', { slot: 'footer', variant: 'default' }, '取消');
      const ok = el('sl-button', { slot: 'footer', variant: opts.danger ? 'danger' : 'primary' }, opts.ok || '确定');
      const d = el('sl-dialog', { label: title, style: '--width:380px' }, el('div', { class: 'asktxt' }, text || ''), cancel, ok);
      document.body.append(d);
      let done = false;
      const finish = v => { if (done) return; done = true; try { d.hide(); } catch (e) {} setTimeout(() => d.remove(), 400); resolve(v); };
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      d.addEventListener('sl-hide', () => finish(false), { once: true });
      d.show();
    });
  } catch (e) { return Promise.resolve(window.confirm(title + '\n' + (text || ''))); }
}
const idmask = s => (s && s.length === 18 ? s.slice(0, 4) + '**********' + s.slice(14) : s || '');
/* ISO 时间 → 北京时间显示（正确性审查：原来直接截取 UTC 字符串，早 8 小时） */
function fmtDT(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); } catch (e) { return String(iso); } }
/* 防御式读取控件值（组件未就绪时不炸） */
const slVal = x => { try { const v = x && x.value; return v == null ? '' : String(v); } catch (e) { return ''; } };
/* 等 Shoelace 组件就绪（超时降级也继续渲染） */
async function slReady() {
  try { await Promise.race([customElements.whenDefined('sl-input'), new Promise(r => setTimeout(r, 2500))]); return !!customElements.get('sl-input'); } catch (e) { return false; }
}
const statusTag = st => ({ '已导入': 'gray', '报到中': 'orange', '在训': 'blue', '请假中': 'orange', '离校办理中': 'orange', '已离校': 'green' }[st] || 'gray');
const has = p => ME.perms.includes(p);

/* ---------- 登录（防御式：组件不可用时降级原生输入框/按钮，手机弱网必达） ---------- */
async function renderLogin() {
  const ready = await slReady();
  const mk = (attrs) => ready ? el('sl-input', attrs)
    : el('input', { name: attrs.name, type: attrs.type || 'text', autocomplete: attrs.autocomplete || '', placeholder: attrs.label + '：' + (attrs.placeholder || ''), 'aria-label': attrs.label, required: true, style: 'width:100%;margin-bottom:12px' });
  const submitBtn = (txt) => ready ? el('sl-button', { type: 'submit', variant: 'primary', size: 'large', style: 'width:100%;margin-top:10px' }, txt)
    : el('button', { type: 'submit', class: 'pri', style: 'width:100%;margin-top:10px;padding:10px' }, txt);
  const loginForm = el('form', { class: 'login-box animate__animated animate__fadeInUp', onsubmit: async e => {
    e.preventDefault();
    try {
      const j = await api('/api/login', { username: slVal($('[name=u]', loginForm)).trim(), password: slVal($('[name=p]', loginForm)) });
      ME = j.user; afterLogin();
    } catch (e2) { toast(e2.message + '（请注意大小写和输入法）', true); }
  } },
    el('h1', {}, '乐恩报道管理系统'),
    el('div', { class: 'sub' }, '仅限内部员工使用'),
    mk({ name: 'u', label: '账号', placeholder: '员工账号或手机号', autocomplete: 'username', autofocus: true }),
    mk({ name: 'p', type: 'password', label: '密码', placeholder: '区分大小写；注意中英文输入法', autocomplete: 'current-password' }),
    submitBtn('登 录'),
    VER ? el('div', { class: 'hint', style: 'margin-top:14px;text-align:center' }, 'v' + VER) : null,
    el('div', { class: 'hint', style: 'margin-top:10px' }, '新员工？', el('a', { href: '#reg', onclick: e => { e.preventDefault(); loginForm.style.display = 'none'; regForm.style.display = ''; } }, '自助注册'), '（提交后由校长激活）'));
  const regForm = el('form', { class: 'login-box animate__animated animate__fadeInUp', style: 'display:none', onsubmit: async e => {
    e.preventDefault();
    try {
      const j = await api('/api/register', { username: slVal($('[name=ru]', regForm)).trim().toLowerCase(), name: slVal($('[name=rn]', regForm)).trim(), password: slVal($('[name=rp]', regForm)) });
      toast(j.msg || '已提交，等待校长激活');
      $('[name=u]', loginForm).value = $('[name=ru]', regForm).value;
      regForm.style.display = 'none'; loginForm.style.display = '';
    } catch (e2) { toast(e2.message, true); }
  } },
    el('h1', {}, '员工注册'),
    el('div', { class: 'sub' }, '注册后需校长激活并分配岗位才能登录'),
    mk({ name: 'rn', label: '真实姓名', placeholder: '用于校长核对身份' }),
    mk({ name: 'ru', label: '账号', placeholder: '小写字母/数字，3-20 位' }),
    mk({ name: 'rp', type: 'password', label: '密码（至少 8 位，区分大小写）' }),
    submitBtn('提交注册'),
    el('div', { class: 'hint', style: 'margin-top:10px' }, el('a', { href: '#', onclick: e => { e.preventDefault(); regForm.style.display = 'none'; loginForm.style.display = ''; } }, '返回登录')));
  $('#app').replaceChildren(el('div', { class: 'login-wrap' }, loginForm, regForm));
}
/* ---------- 布局 ---------- */
const NAV = [
  ['dash', '概览', null, 'layout-dashboard'], ['students', '学生', 'student.view', 'users'], ['checkin', '报到', 'student.view', 'scan-line'], ['fees', '缴费', 'fee.record', 'wallet'], ['dorm', '宿舍', 'dorm.assign', 'bed-double'],
  ['supplies', '物资', 'student.view', 'package'], ['books', '发书', 'student.view', 'book-open'], ['attendance', '考勤', 'att.view', 'fingerprint'],
  ['leaves', '请假销假', 'leave.record', 'calendar-minus'], ['scores', '成绩', 'score.view', 'clipboard-list'], ['departure', '离校', 'depart.process', 'door-open'],
  ['import', '学生导入', 'student.import', 'file-spreadsheet'], ['reports', '报表', 'report.view', 'bar-chart-3'], ['users', '员工', 'admin.users', 'user-cog'],
  ['positions', '岗位权限', 'admin.positions', 'shield-check'], ['audit', '审计', 'audit.view', 'scroll-text'],
];
function afterLogin() {
  if (ME.must_change) return renderChangePW(true);
  buildLayout();
  location.hash = location.hash || '#dash';
  route();
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  document.documentElement.classList.toggle('sl-theme-dark', cur === 'dark');
  try { localStorage.setItem('lenen-theme', cur); } catch (e) {}
  buildLayout(); route();
}
/* 通用 sl-dialog 弹窗 */
function slDialog(label, bodyNodes, footerNodes) {
  return new Promise(resolve => {
    const d = el('sl-dialog', { label }, el('div', {}, ...bodyNodes), ...footerNodes);
    document.body.append(d);
    const close = () => { try { d.hide(); } catch (e) {} setTimeout(() => d.remove(), 400); };
    d.addEventListener('sl-hide', () => { resolve(null); setTimeout(() => d.remove(), 400); }, { once: true });
    resolve({ d, close });
    d.show();
  });
}
function buildLayout() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const side = el('div', { class: 'side' },
    el('div', { class: 'logo' }, '乐恩报道管理'),
    ...NAV.filter(n => !n[2] || has(n[2])).map(n => el('a', { href: '#' + n[0], 'data-k': n[0] }, icon(n[3]), el('span', {}, n[1]))),
    el('button', { class: 'theme-toggle', onclick: toggleTheme }, icon(dark ? 'sun' : 'moon'), ' ', dark ? '亮色模式' : '暗色模式'),
    el('div', { class: 'who' }, el('b', {}, ME.name), `${ME.position || '未分配岗位'}`,
      el('a', { href: '#pw', onclick: e => { e.preventDefault(); renderChangePW(); } }, '改密码'), ' · ',
      el('a', { href: '#', onclick: async e => { e.preventDefault(); await api('/api/logout', {}); location.reload(); } }, '退出')));
  $('#app').replaceChildren(el('div', { class: 'layout' }, side, el('div', { class: 'main', id: 'main' })));
}
function page(title, desc, ...kids) {
  return [el('h2', {}, title), el('div', { class: 'desc' }, desc), ...kids];
}
async function route() {
  if (!ME) return;
  try { if (pageCleanup) { pageCleanup(); } } catch (e) {} pageCleanup = null; // 离开页面前释放资源（摄像头等）
  const k = (location.hash || '#dash').slice(1);
  $$('.side a').forEach(a => a.classList.toggle('on', a.dataset.k === k));
  const main = $('#main'); main.classList.remove('animate__animated', 'animate__fadeIn', 'animate__faster'); main.replaceChildren();
  if (k === 'pw') return renderChangePW();
  const def = NAV.find(n => n[0] === k);
  if (!def) { location.hash = '#dash'; return; }
  if (def[2] && !has(def[2])) { main.append(el('div', { class: 'card' }, '没有该页面权限')); return; }
  try { await PAGES[k](main); main.classList.add('animate__animated', 'animate__fadeIn', 'animate__faster'); } catch (e) { main.append(el('div', { class: 'card err' }, e.message)); }
}
window.addEventListener('hashchange', route);

/* ---------- 通用：学生搜索选择 ---------- */
function pickStudent(placeholder, onPick) {
  const input = el('input', { placeholder: placeholder || '输入姓名/身份证号/手机号搜索…', style: 'width:300px' });
  const box = el('div');
  let timer = null, seq = 0;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => {
    const q = input.value.trim(); if (q.length < 1) { box.replaceChildren(); return; }
    const my = ++seq;
    try {
      const j = await api('/api/students?q=' + encodeURIComponent(q));
      if (my !== seq) return; // 慢链路下旧响应后到，丢弃
      box.replaceChildren(...j.students.slice(0, 8).map(s => el('div', { class: 'row', style: 'margin:0;padding:4px 0' },
        el('a', { href: '#', onclick: e => { e.preventDefault(); onPick(s); box.replaceChildren(); } },
          `${s.name}（${s.class_name || '未分班'}·${s.status}） ${idmask(s.idcard)}`))));
    } catch (e) { box.replaceChildren(el('span', { class: 'err' }, e.message)); }
  }, 250); });
  return el('div', {}, el('div', { class: 'row' }, input), box);
}
function stat(n, label) { return el('div', { class: 'stat' }, el('b', {}, String(n)), el('span', {}, label)); }
function downloadCsv(path, name) { fetch(path).then(r => { if (!r.ok) throw 0; return r.blob(); }).then(b => {
  const a = el('a', { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); toast('已导出 ' + name);
}).catch(() => toast('导出失败（需要「导出数据」权限）', true)); }

/* ---------- 页面 ---------- */
const PAGES = {
async dash(m) {
  let fees = { byStatus: [] }, att = { present: 0, total: 0, missing: [], leave: 0 };
  try { fees = await api('/api/report/fees'); att = await api('/api/report/attendance'); } catch {}
  m.append(...page('概览', '今天：' + att.date,
    el('div', {}, stat((fees.byStatus.find(x => x.status === '在训') || {}).n || 0, '在训'),
      stat((fees.byStatus.find(x => x.status === '报到中') || {}).n || 0, '报到中(缴费/分宿未完)'),
      stat((fees.byStatus.find(x => x.status === '已导入') || {}).n || 0, '已导入未报到'),
      stat((fees.byStatus.find(x => x.status === '请假中') || {}).n || 0, '请假中'),
      stat((fees.byStatus.find(x => x.status === '离校办理中') || {}).n || 0, '离校办理中'),
      stat((fees.byStatus.find(x => x.status === '已离校') || {}).n || 0, '已离校')),
    has('att.view') ? el('div', { class: 'card' }, el('h3', {}, `今日考勤：出勤 ${att.present} / 应到 ${att.total}，请假 ${att.leave}，缺勤 ${att.missing.length}`),
      el('div', { class: 'muted' }, att.missing.slice(0, 30).map(s => s.name).join('、') || '无缺勤')) : null,
  ));
},
async students(m) {
  m.append(...page('学生', '浏览/搜索全部学生，点姓名看档案（缴费/宿舍/物资/请假/考勤），可改电话与班级', el('div', { id: 'stubox' })));
  const box = $('#stubox');
  const q = el('input', { placeholder: '搜索：姓名 / 身份证 / 手机号 / 班级', style: 'width:280px' });
  const st = el('select', {}, el('option', { value: '' }, '全部状态'),
    ...['已导入', '报到中', '在训', '请假中', '离校办理中', '已离校'].map(x => el('option', { value: x }, x)));
  const list = el('div');
  const drawer = el('div');
  let timer = null;
  async function reload() {
    const j = await api('/api/students?q=' + encodeURIComponent(q.value.trim()) + (st.value ? '&status=' + encodeURIComponent(st.value) : ''));
    const rows = j.students.map(x => {
      const tr = el('tr', {},
        el('td', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); show(x.id); } }, x.name)),
        el('td', {}, x.sex),
        el('td', {}, x.class_name || '未分班'),
        el('td', {}, el('span', { class: 'tag ' + statusTag(x.status) }, x.status)),
        el('td', {}, x.phone || ''),
        el('td', { class: 'muted' }, fmtDT(x.checkin_at) || '—'));
      return tr;
    });
    const thead = el('thead', {}, el('tr', {},
      el('th', {}, '姓名'), el('th', {}, '性别'), el('th', {}, '班级'),
      el('th', {}, '状态'), el('th', {}, '电话'), el('th', {}, '报到时间')));
    const tbl = el('table', {}, thead, el('tbody', {}, rows));
    const totalN = j.total ?? j.students.length;
    const titleTxt = j.has_more ? `共 ${totalN} 人（当前显示前 ${j.students.length} 人，可搜索缩小范围）` : `共 ${totalN} 人`;
    const card = el('div', { class: 'card' }, el('h3', {}, titleTxt), tbl);
    list.replaceChildren(card);
  }
  async function show(sid) {
    let j; try { j = await api('/api/student/detail', { id: sid }); } catch (e) { return toast(e.message, true); }
    const x = j.student;
    const name = el('input', { value: x.name, style: 'width:110px' });
    const phone = el('input', { value: x.phone || '', style: 'width:140px' });
    const klass = el('input', { value: x.class_name || '', placeholder: '班级', style: 'width:130px' });
    const feeRows = j.fees.map(f => {
      const tr = el('tr', {},
        el('td', {}, f.item), el('td', {}, String(f.amount)),
        el('td', {}, f.paid ? el('span', { class: 'tag green' }, '已缴') : el('span', { class: 'tag red' }, '未缴')),
        el('td', {}, f.method || ''));
      return tr;
    });
    const feeTbl = el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, '费项'), el('th', {}, '金额'), el('th', {}, '状态'), el('th', {}, '方式'))), el('tbody', {}, feeRows));
    const parts = [];
    parts.push(el('h3', {}, x.name + ' ', el('span', { class: 'tag ' + statusTag(x.status) }, x.status)));
    parts.push(j.has_photo ? el('img', { class: 'photo', src: '/api/photo?sid=' + x.id }) : el('span', { class: 'muted' }, '（无照片）'));
    parts.push(el('div', { class: 'row' }, `身份证 ${idmask(x.idcard)} · ${x.sex} · 电话 ${x.phone || '—'} · 录入 ${fmtDT(x.created_at).slice(0, 10)}`));
    parts.push(el('div', { class: 'row' },
      j.fee_ok ? el('span', { class: 'ok-t' }, '缴费已齐 ✓') : el('span', { class: 'warn-t' }, '缴费未齐'),
      j.dorm ? ` · 宿舍 ${j.dorm.building} ${j.dorm.floor}层 ${j.dorm.room}` : ' · 未分宿舍'));
    parts.push(feeTbl);
    const ledCount = j.supplies.filter(s2 => s2.status === '已领').length;
    const bookCount = j.books.reduce((a, b2) => a + b2.count, 0);
    parts.push(el('div', { class: 'row' }, `物资 ${ledCount}/${j.supplies.length} 已领 · 书 ${bookCount} 本 · 请假单 ${j.leaves.length} 张 · 考勤 ${j.att.length} 条`));
    if (j.scores && j.scores.length) parts.push(el('div', { class: 'row' }, '成绩：', j.scores.map(s2 => `${s2.exam}/${s2.subject} ${s2.value}`).join('，')));
    if (has('student.edit')) {
      parts.push(el('div', { class: 'row', style: 'margin-top:8px' }, name, phone, klass,
        el('button', { class: 'pri sm', onclick: async () => {
          try { await api('/api/student/edit', { id: x.id, name: name.value, phone: phone.value, class_name: klass.value }); toast('已保存'); reload(); show(x.id); } catch (e2) { toast(e2.message, true); }
        } }, '保存修改')));
    }
    parts.push(el('div', { class: 'row' }, el('button', { onclick: () => drawer.replaceChildren() }, '收起')));
    drawer.replaceChildren(el('div', { class: 'card animate__animated animate__fadeInUp animate__faster' }, parts));
    drawer.scrollIntoView({ behavior: 'smooth' });
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reload, 250); });
  st.addEventListener('change', reload);
  box.append(el('div', { class: 'card' }, el('div', { class: 'row' }, q, st)), drawer, list);
  reload();
},
async import(m) {
  const report = el('div');
  m.append(...page('学生导入', '下载 Excel 模板 → 填好 → 导入（支持 .xlsx / .csv）；错误行逐条列出，不会静默跳过',
    el('div', { class: 'card' }, el('div', { class: 'row' },
      el('a', { href: '/api/students/template' }, el('button', { type: 'button' }, '下载 Excel 模板')),
      el('input', { type: 'file', id: 'imp-file', accept: '.xlsx,.csv,.txt' }),
      el('button', { class: 'pri', onclick: async e => {
        const f = $('#imp-file').files[0]; if (!f) return toast('先选文件', true);
        const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); });
        report.replaceChildren(el('span', { class: 'muted' }, '导入中…'));
        try { const j = await api('/api/students/import', { filename: f.name, b64 });
          report.replaceChildren(el('div', {}, el('b', {}, `成功导入 ${j.ok} 人（文件 ${j.total} 行）`)),
            ...j.errors.slice(0, 200).map(x => el('div', { class: 'err' }, `第 ${x.row} 行：${x.msg}`)));
        } catch (e2) { report.replaceChildren(el('div', { class: 'err' }, e2.message)); }
      } }, '开始导入')),
    report)));
},
async checkin(m) {
  m.append(...page('报到', '读卡器光标点进输入框后直接刷卡；新学生建档+拍照+手机号确认，老学生调档', el('div', { id: 'ck' })));
  const box = $('#ck');
  const photoStu = { b64: null };
  const input = el('input', { class: 'big-input mono', placeholder: '刷卡或输入 18 位身份证号后回车', autofocus: true });
  const panel = el('div');
  let cam = null;
  function stopCam() { if (cam) { cam.getTracks().forEach(t => t.stop()); cam = null; } }
  pageCleanup = stopCam; // 切页自动关摄像头（正确性审查修复：原来切走后摄像头一直开着）
  async function startCam(area) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480 } });
      cam = stream;
      const v = el('video', { id: 'cam', autoplay: true, playsinline: true }); v.srcObject = stream;
      area.replaceChildren(v, el('div', { class: 'row', style: 'margin-top:6px' },
        el('button', { class: 'pri', onclick: () => {
          const cv = el('canvas'); cv.width = 360; cv.height = 480;
          const ctx = cv.getContext('2d'); ctx.drawImage(v, 0, 0, 360, 480);
          photoStu.b64 = cv.toDataURL('image/jpeg', 0.8).split(',')[1];
          area.replaceChildren(el('img', { class: 'photo', src: cv.toDataURL('image/jpeg', 0.8) }), el('div', { class: 'row' },
            el('button', { onclick: () => { photoStu.b64 = null; startCam(area); } }, '重拍')));
          stopCam();
        } }, '拍照'), el('button', { onclick: () => { stopCam(); area.replaceChildren(el('span', { class: 'muted' }, '未拍照')); } }, '跳过')));
    } catch { area.replaceChildren(el('span', { class: 'warn-t' }, '打不开摄像头（可用「选择照片文件」代替）'),
      el('input', { type: 'file', accept: 'image/*', onchange: async e => { const f = e.target.files[0]; if (!f) return;
        photoStu.b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => {
          const img = new Image(); img.onload = () => { const cv = el('canvas'); cv.width = 360; cv.height = 480;
            cv.getContext('2d').drawImage(img, 0, 0, 360, 480); res(cv.toDataURL('image/jpeg', 0.8).split(',')[1]); }; img.src = r.result; }; r.readAsDataURL(f); });
        toast('照片已就绪'); } })); }
  }
  async function lookup() {
    const idcard = input.value.trim();
    if (!idcard) return;
    let j;
    try { j = await api('/api/checkin/lookup', { idcard }); } catch (e) { return toast(e.message, true); }
    input.value = ''; panel.replaceChildren();
    if (!j.found) {
      const name = el('input', { placeholder: '姓名（必填）' }), phone = el('input', { placeholder: '手机号（必填）' }), klass = el('input', { placeholder: '班级（可选）' });
      const camArea = el('div');
      panel.append(el('div', { class: 'card' }, el('h3', {}, '新学生建档'), el('div', { class: 'hint' }, `身份证号 ${j.idcard}（${j.sex}，校验通过）`), el('div', { class: 'row' }, name, phone, klass), camArea,
        el('div', { class: 'row' }, el('button', { class: 'pri', onclick: async () => {
          try { const r = await api('/api/checkin/confirm', { idcard: j.idcard, name: name.value, phone: phone.value, class_name: klass.value, photo_b64: photoStu.b64 });
            toast(`${r.student.name} 建档并报到`); showProfile(r.student.id, r.fee_ok);
          } catch (e2) { toast(e2.message, true); }
        } }, '确认建档并报到'))));
      startCam(camArea);
      return;
    }
    const s = j.student;
    if (['在训', '离校办理中', '已离校'].includes(s.status)) {
      panel.append(el('div', { class: 'card' }, el('h3', {}, `${s.name}（${s.status}）`),
        el('div', { class: 'warn-t' }, '该生已完成报到或已离校，不能重复报到。'),
        el('button', { onclick: () => showProfile(s.id, j.fee_ok) }, '查看档案')));
      return;
    }
    const phone = el('input', { value: s.phone || '', placeholder: '手机号（必填）' });
    const camArea = el('div');
    panel.append(el('div', { class: 'card' }, el('h3', {}, `老学生报到：${s.name}（${s.sex}，${s.class_name || '未分班'}，${s.status}）`),
      el('div', { class: 'row' }, phone), camArea,
      el('div', { class: 'row' }, el('button', { class: 'pri', onclick: async () => {
        try { const r = await api('/api/checkin/confirm', { idcard: j.idcard, phone: phone.value, photo_b64: photoStu.b64 });
          toast(`${r.student.name} 报到登记完成`); showProfile(r.student.id, r.fee_ok);
        } catch (e2) { toast(e2.message, true); }
      } }, '二次确认并登记报到时间'),
      el('button', { onclick: () => showProfile(s.id, j.fee_ok) }, '只看档案'))));
    startCam(camArea);
  }
  async function showProfile(sid, feeOk) {
    stopCam();
    let j; try { j = await api('/api/student/detail', { id: sid }); } catch (e) { return toast(e.message, true); }
    const s = j.student;
    const feeRows = () => j.fees.map(f => el('tr', {}, el('td', {}, f.item), el('td', {}, String(f.amount)), el('td', {}, f.paid ? el('span', { class: 'tag green' }, '已缴') : el('span', { class: 'tag red' }, '未缴')),
      el('td', {}, f.method || ''), el('td', { class: 'muted' }, fmtDT(f.at))));
    panel.replaceChildren(el('div', { class: 'card' },
      el('h3', {}, `${s.name} `, el('span', { class: 'tag ' + statusTag(s.status) }, s.status), j.has_photo ? el('img', { class: 'photo', src: '/api/photo?sid=' + s.id, style: 'float:right;margin-top:-6px' }) : el('span', { class: 'muted' }, '（无照片）')),
      el('div', { class: 'row' }, `身份证 ${idmask(s.idcard)} · ${s.sex} · ${s.class_name || '未分班'} · 电话 ${s.phone || '—'} · 报到时间 ${fmtDT(s.checkin_at) || '—'}`),
      el('div', { class: 'row' }, el('b', {}, j.fee_ok ? '缴费已齐 ✓（可分宿舍）' : '缴费未齐（不能自动分宿舍）')),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '项目'), el('th', {}, '金额'), el('th', {}, '状态'), el('th', {}, '方式'), el('th', {}, '登记时间'))), el('tbody', {}, feeRows())),
      j.dorm ? el('div', { class: 'row' }, `宿舍：${j.dorm.building} ${j.dorm.floor}层 ${j.dorm.room}`) : el('div', { class: 'row muted' }, '未分配宿舍'),
      el('div', { class: 'row' }, has('fee.record') ? el('button', { onclick: () => { location.hash = '#fees'; sessionStorage.setItem('fee_sid', s.id); route(); } }, '去登记缴费') : null,
        has('dorm.assign') && j.fee_ok && !j.dorm ? el('button', { onclick: () => { location.hash = '#dorm'; } }, '去分宿舍') : null)));
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
  box.append(el('div', { class: 'card' }, el('div', { class: 'row' }, input, el('button', { class: 'pri', onclick: lookup }, '查询 / 报到')), el('div', { class: 'hint' }, '二代证阅读器用键盘仿真模式：刷一下=自动填号+回车')), panel);
  input.focus();
},
async fees(m) {
  m.append(...page('缴费登记', '五项费用金额由员工人工录入（可为 0），登记后不可随意改金额（改金额需「修改缴费金额」权限）', el('div', { id: 'feebox' })));
  const box = $('#feebox');
  const preId = sessionStorage.getItem('fee_sid'); sessionStorage.removeItem('fee_sid');
  const editor = el('div');
  const ITEMS = ['报名费', '住宿费', '书费', '学费', '押金'];
  async function edit(sid) {
    let j; try { j = await api('/api/student/detail', { id: sid }); } catch (e) { return toast(e.message, true); }
    const s = j.student;
    editor.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `${s.name}（${s.class_name || '未分班'}）`),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '项目'), el('th', {}, '金额'), el('th', {}, '缴费方式'), el('th', {}, '状态'), el('th', {}, '操作'))),
        el('tbody', {}, ITEMS.map(it => {
          const cur = j.fees.find(f => f.item === it) || { amount: 0, paid: 0, method: '' };
          const amount = el('input', { type: 'number', min: '0', step: '0.01', value: cur.amount || 0, style: 'width:100px' });
          const method = el('input', { value: cur.method || '', placeholder: '现金/转账', style: 'width:110px' });
          const paid = el('input', { type: 'checkbox' }); paid.checked = !!cur.paid;
          return el('tr', {}, el('td', {}, it), el('td', {}, amount), el('td', {}, method),
            el('td', {}, cur.paid ? el('span', { class: 'tag green' }, '已缴') : el('span', { class: 'tag red' }, '未缴')),
            el('td', {}, el('button', { class: 'pri sm', onclick: async () => {
              try { const r = await api('/api/fees/set', { student_id: sid, item: it, amount: Number(amount.value), paid: paid.checked, method: method.value });
                toast(`${it} 已登记`); if (r.fee_ok) toast('缴费已齐 ✓ 可以分宿舍了'); edit(sid);
              } catch (e2) { toast(e2.message, true); }
            } }, '保存'))); }))),
      el('div', { class: 'row' }, j.fee_ok ? el('span', { class: 'ok-t' }, '五项中必缴四项已齐（押金不阻塞分宿）') : el('span', { class: 'warn-t' }, '缴费未齐'))));
  }
  box.append(el('div', { class: 'card' }, pickStudent('搜索学生（姓名/身份证/手机号）…', s => edit(s.id))), editor);
  if (preId) edit(Number(preId));
},
async dorm(m) {
  m.append(...page('宿舍', '建宿舍（床位数人工输入）→ 自动分配（缴费已齐者优先按序分）→ 手动分配/调换', el('div', { id: 'dormbox' })));
  const box = $('#dormbox');
  async function reload() {
    const j = await api('/api/dorms');
    const occByDorm = new Map();
    for (const o of j.occupants) { if (!occByDorm.has(o.dorm_id)) occByDorm.set(o.dorm_id, []); occByDorm.get(o.dorm_id).push(o.name); }
    const dormRows = j.dorms.map(d => el('tr', {}, el('td', {}, d.building), el('td', {}, String(d.floor)), el('td', {}, d.room),
      el('td', {}, d.sex), el('td', {}, `${d.used}/${d.beds}`), el('td', {}, d.bad ? el('span', { class: 'tag red' }, '坏') : el('span', { class: 'tag green' }, '好')),
      el('td', { class: 'muted' }, (occByDorm.get(d.id) || []).join('、')),
      el('td', {}, el('button', { class: 'sm dgr', title: '删除该宿舍', 'aria-label': '删除宿舍', onclick: async () => { if (!(await askConfirm('删除该宿舍？', d.building + ' ' + d.room + '（需无人入住）', { danger: true }))) return;
        try { await api('/api/dorms/delete', { id: d.id }); reload(); } catch (e) { toast(e.message, true); } } }, '删'))));
    // 表单
    const b = el('input', { placeholder: '楼栋（如 1号楼）', style: 'width:110px' }), f = el('input', { type: 'number', min: '1', placeholder: '楼层', style: 'width:70px' }),
      r = el('input', { placeholder: '宿舍号（如 101）', style: 'width:90px' }), sx = el('select', {}, el('option', { value: '男' }, '男'), el('option', { value: '女' }, '女')),
      beds = el('input', { type: 'number', min: '1', max: '20', placeholder: '床位数', style: 'width:80px' }), bad = el('input', { type: 'checkbox' });
    const assignStu = { id: null }; const swapA = { id: null }; const swapB = { id: null };
    const swapHint = el('span', { class: 'muted' }, '未选');
    const t1 = el('span', { class: 'muted' }, '未选'), t2 = el('span', { class: 'muted' }, '未选');
    box.replaceChildren(
      el('div', { class: 'card' }, el('h3', {}, '新建宿舍'),
        el('div', { class: 'row' }, b, f, r, sx, beds, el('label', {}, bad, ' 坏宿舍'), el('button', { class: 'pri', onclick: async () => {
          try { await api('/api/dorms/save', { building: b.value, floor: Number(f.value), room: r.value, sex: sx.value, beds: Number(beds.value), bad: bad.checked }); toast('已新建'); reload(); } catch (e) { toast(e.message, true); }
        } }, '添加'))),
      has('dorm.assign') ? el('div', { class: 'card' }, el('h3', {}, '自动分配（缴费已齐的「报到中」学生，按同性别空床位顺序）'),
        el('div', { class: 'row' }, el('button', { class: 'pri', onclick: async () => {
          if (!(await askConfirm('自动分配宿舍？', '对全部「报到中且缴费已齐」的学生，按同性别空床位顺序分配', { ok: '开始分配' }))) return;
          try { const r2 = await api('/api/dorm/auto', {}); toast(`分配 ${r2.assigned} 人`); r2.skipped.slice(0, 10).forEach(x => toast(`跳过 ${x.name}：${x.why}`, true)); reload(); } catch (e) { toast(e.message, true); }
        } }, '一键自动分配'))) : null,
      el('div', { class: 'card' }, el('h3', {}, '手动分配'),
        el('div', { class: 'row' }, pickStudent('搜索学生…', s => { assignStu.id = s.id; t1.textContent = s.name; })),
        el('div', { class: 'row' }, '选到：', t1, ' → 宿舍：', el('select', { id: 'dormsel' }, j.dorms.filter(d => !d.bad && d.used < d.beds).map(d => el('option', { value: d.id }, `${d.building} ${d.floor}层 ${d.room}（${d.sex} ${d.used}/${d.beds}）`))),
          el('button', { class: 'pri', onclick: async () => {
            if (!assignStu.id) return toast('先选学生', true);
            try { await api('/api/dorm/assign', { student_id: assignStu.id, dorm_id: Number($('#dormsel').value) }); toast('已分配'); reload(); } catch (e) { toast(e.message, true); }
          } }, '分配'))),
      el('div', { class: 'card' }, el('h3', {}, '调换（两人互换床位；只有一方有床位时=转移床位）'),
        el('div', { class: 'row' }, '甲：', pickStudent('搜索学生 A…', s => { swapA.id = s.id; t2.textContent = `${s.name}`; }),
          ' 乙：', pickStudent('搜索学生 B…', s => { swapB.id = s.id; swapHint.textContent = '已选：' + s.name; }), swapHint,
          el('button', { onclick: async () => {
            if (!swapA.id || !swapB.id) return toast('甲乙都要选', true);
            try { await api('/api/dorm/swap', { a: swapA.id, b: swapB.id }); toast('已调换'); reload(); } catch (e) { toast(e.message, true); }
          } }, '执行调换'))),
      el('div', { class: 'card' }, el('h3', {}, (() => {
        const tb2 = j.dorms.reduce((a, d2) => a + d2.beds, 0), ub2 = j.dorms.reduce((a, d2) => a + d2.used, 0);
        const fm2 = j.dorms.filter(d2 => d2.sex === '男' && !d2.bad).reduce((a, d2) => a + d2.beds - d2.used, 0);
        const ff2 = j.dorms.filter(d2 => d2.sex === '女' && !d2.bad).reduce((a, d2) => a + d2.beds - d2.used, 0);
        return `宿舍一览（${j.dorms.length} 间 · 床位 ${ub2}/${tb2} · 空床 男${fm2} 女${ff2}）`;
      })()),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '楼栋'), el('th', {}, '层'), el('th', {}, '宿舍'), el('th', {}, '性别'), el('th', {}, '住/床'), el('th', {}, '状态'), el('th', {}, '在住'), el('th', {}, ''))), el('tbody', {}, dormRows))));
  }
  await reload();
},
async supplies(m) {
  m.append(...page('物资登记', '先维护物资目录，再按学生登记领取情况（可标注缺失）', el('div', { id: 'supbox' })));
  const box = $('#supbox');
  const editor = el('div');
  async function loadCatalog() { return (await api('/api/supplies/catalog')).catalog; }
  let catalog = await loadCatalog();
  async function edit(sid) {
    const j = await api('/api/supply/list', { student_id: sid });
    const s = (await api('/api/student/detail', { id: sid })).student;
    editor.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `${s.name} 的物资`),
      el('table', {}, el('tbody', {}, catalog.map(it => {
        const rec = j.records.find(r => r.item_id === it.id) || { status: '未领', note: '' };
        const sel = el('select', {}, ['已领', '未领', '缺'].map(x => el('option', { value: x, selected: x === rec.status ? true : undefined }, x)));
        const note = el('input', { value: rec.note, placeholder: '备注（缺什么写什么）', style: 'width:200px' });
        return el('tr', {}, el('td', {}, it.name), el('td', {}, sel), el('td', {}, note),
          el('td', {}, el('button', { class: 'pri sm', onclick: async () => {
            try { await api('/api/supply/set', { student_id: sid, item_id: it.id, status: sel.value, note: note.value }); toast('已登记'); } catch (e) { toast(e.message, true); }
          } }, '保存')));
      })))));
  }
  const name = el('input', { placeholder: '新物资名称' });
  box.append(el('div', { class: 'card' }, el('h3', {}, '物资目录'),
    el('div', { class: 'row' }, ...catalog.map(c2 => el('span', { class: 'tag gray' }, c2.name, ' ', el('a', { href: '#', class: 'dgr', onclick: async e => { e.preventDefault(); await api('/api/supplies/catalog', { name: 'x', delete_id: c2.id }); catalog = await loadCatalog(); route(); } }, '×')))),
    el('div', { class: 'row' }, name, el('button', { onclick: async () => { try { await api('/api/supplies/catalog', { name: name.value }); catalog = await loadCatalog(); route(); } catch (e) { toast(e.message, true); } } }, '添加物资'))),
    el('div', { class: 'card' }, el('h3', {}, '按学生登记'), pickStudent('搜索学生…', s => edit(s.id))), editor);
},
async books(m) {
  m.append(...page('发书', '登记书目后，发一本点一下（计数）', el('div', { id: 'bookbox' })));
  const box = $('#bookbox'); const editor = el('div');
  let catalog = (await api('/api/books/catalog')).catalog;
  async function edit(sid) {
    const j = await api('/api/book/list', { student_id: sid });
    const s = (await api('/api/student/detail', { id: sid })).student;
    editor.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `给 ${s.name} 发书`),
      el('table', {}, el('tbody', {}, catalog.map(bk => {
        const rec = j.records.find(r => r.book_id === bk.id);
        return el('tr', {}, el('td', {}, bk.name), el('td', {}, rec ? `已发 ${rec.count} 本` : el('span', { class: 'muted' }, '未发')),
          el('td', {}, el('button', { class: 'pri sm', onclick: async () => {
            try { const r = await api('/api/book/give', { student_id: sid, book_id: bk.id }); toast(`已发 1 本（累计 ${r.count}）`); edit(sid); } catch (e) { toast(e.message, true); }
          } }, '发一本')));
      })))));
  }
  const name = el('input', { placeholder: '新书名' });
  box.append(el('div', { class: 'card' }, el('h3', {}, '书目'),
    el('div', { class: 'row' }, ...catalog.map(c2 => el('span', { class: 'tag gray' }, c2.name))),
    el('div', { class: 'row' }, name, el('button', { onclick: async () => { try { await api('/api/books/catalog', { name: name.value }); catalog = (await api('/api/books/catalog')).catalog; route(); } catch (e) { toast(e.message, true); } } }, '添加书目'))),
    el('div', { class: 'card' }, el('h3', {}, '按学生发书'), pickStudent('搜索学生…', s => edit(s.id))), editor);
},
async attendance(m) {
  m.append(...page('考勤', '刷卡打卡（光标在输入框直接刷）；下方是当日名单与缺勤', el('div', { id: 'attbox' })));
  const box = $('#attbox');
  const dateInput = el('input', { type: 'date', value: new Date().toLocaleDateString('sv-SE'), onchange: () => loadDay() });
  const table = el('div');
  const result = el('div', { class: 'card' });
  const input = el('input', { class: 'big-input mono', placeholder: '刷卡或输入身份证号后回车', autofocus: true });
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const idcard = input.value.trim();
    if (!idcard) return;
    try {
      const j = await api('/api/att/tap', { idcard });
      input.value = '';
      result.replaceChildren(el('h3', {}, j.msg),
        j.known ? el('div', { class: 'row' },
          j.has_photo ? el('img', { class: 'photo', src: '/api/photo?sid=' + j.student.id }) : el('span', { class: 'warn-t' }, '（无存档照片，请人工核对）'),
          el('div', {}, el('b', {}, j.student.name), el('br'), `${j.student.sex} · ${j.student.class_name || '未分班'} · ${j.student.status}`, j.leave_open ? el('div', { class: 'warn-t' }, '该生在请假期间刷卡') : null)) : null);
      loadDay();
    } catch (e2) { result.replaceChildren(el('div', { class: 'err' }, e2.message)); }
    input.focus();
  });
  async function loadDay() {
    const j = await api('/api/att/day?date=' + dateInput.value);
    table.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `${j.date} 名单（出勤 ${j.rows.filter(r => r.state === '出勤').length} / 请假 ${j.rows.filter(r => r.state === '请假').length} / 缺勤 ${j.rows.filter(r => r.state === '缺勤').length}）`),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '姓名'), el('th', {}, '班级'), el('th', {}, '状态'), el('th', {}, '打卡时间'), el('th', {}, has('att.manual') ? '补卡操作' : ''))),
        el('tbody', {}, j.rows.map(r => el('tr', {}, el('td', {}, r.name), el('td', {}, r.class_name || ''),
          el('td', {}, el('span', { class: 'tag ' + ({ 出勤: 'green', 请假: 'orange', 缺勤: 'red' }[r.state]) }, r.state), r.tap && r.tap.note ? el('span', { class: 'muted' }, ' ' + r.tap.note) : null),
          el('td', {}, r.tap ? fmtDT(r.tap.at).slice(11, 19) : ''),
          el('td', {}, has('att.manual') ? el('button', { class: 'sm', onclick: async () => {
            try { if (r.tap) { if (!(await askConfirm('删除该日打卡？', r.name + ' · ' + j.date, { danger: true }))) return; await api('/api/att/manual', { student_id: r.id, date: j.date, remove: true }); }
              else { await api('/api/att/manual', { student_id: r.id, date: j.date, note: '人工补卡' }); }
            loadDay(); } catch (e) { toast(e.message, true); }
          } }, r.tap ? '删卡' : '补卡') : '')))))));
  }
  box.append(el('div', { class: 'card' }, input, result), el('div', { class: 'row' }, '日期：', dateInput), table);
  loadDay();
},
async leaves(m) {
  m.append(...page('请假销假', '员工代学生登记请假；回来后销假', el('div', { id: 'lvbox' })));
  const box = $('#lvbox'); const list = el('div');
  const stu = { id: null }; const stuName = el('span', { class: 'muted' }, '未选');
  const from = el('input', { type: 'date', value: new Date().toLocaleDateString('sv-SE') });
  const to = el('input', { type: 'date', value: new Date().toLocaleDateString('sv-SE') });
  const reason = el('input', { placeholder: '事由', style: 'width:220px' });
  async function reload() {
    const j = await api('/api/leaves');
    list.replaceChildren(el('div', { class: 'card' }, el('h3', {}, '请假单'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '学生'), el('th', {}, '班级'), el('th', {}, '起'), el('th', {}, '止'), el('th', {}, '事由'), el('th', {}, '状态'), el('th', {}, '销假'), el('th', {}, ''))),
        el('tbody', {}, j.leaves.map(l => el('tr', {}, el('td', {}, l.name), el('td', {}, l.class_name || ''), el('td', {}, l.from_d), el('td', {}, l.to_d), el('td', {}, l.reason),
          el('td', {}, l.status === 'open' ? el('span', { class: 'tag orange' }, '请假中') : el('span', { class: 'tag green' }, '已销假')),
          el('td', { class: 'muted' }, fmtDT(l.closed_at)),
          el('td', {}, l.status === 'open' && has('leave.close') ? el('button', { class: 'pri sm', onclick: async () => {
            try { await api('/api/leave/close', { id: l.id }); toast('已销假'); reload(); } catch (e) { toast(e.message, true); } } }, '销假') : '')))))));
  }
  box.append(el('div', { class: 'card' }, el('h3', {}, '登记请假'),
    el('div', { class: 'row' }, pickStudent('搜索学生…', s => { stu.id = s.id; stuName.textContent = s.name; }), '选到：', stuName),
    el('div', { class: 'row' }, from, ' 至 ', to, reason, el('button', { class: 'pri', onclick: async () => {
      if (!stu.id) return toast('先选学生', true);
      if (!from.value || !to.value) return toast('请选择请假起止日期', true);
      if (to.value < from.value) return toast('结束日期不能早于开始日期', true);
      try { await api('/api/leave/add', { student_id: stu.id, from: from.value, to: to.value, reason: reason.value }); toast('已登记'); reload(); } catch (e) { toast(e.message, true); }
    } }, '登记'))), list);
  reload();
},
async scores(m) {
  m.append(...page('成绩', '阅卷机导出文件（CSV/Excel）导入，默认列映射：身份证号列 + 成绩列，可手填列号', el('div', { id: 'scbox' })));
  const box = $('#scbox');
  const rep = el('div');
  const exam = el('input', { placeholder: '考试名（如 入学模考一）' }), subject = el('input', { placeholder: '科目（如 行测）' });
  const file = el('input', { type: 'file', accept: '.csv,.xlsx,.txt' });
  const c1 = el('input', { placeholder: '身份证号列号(可空)', style: 'width:130px' }), c2 = el('input', { placeholder: '成绩列号(可空)', style: 'width:110px' });
  const list = el('div');
  async function reload() {
    const j = await api('/api/scores/list');
    list.replaceChildren(el('div', { class: 'card' }, el('h3', {}, '成绩查询'),
      el('div', { class: 'row' }, '考试：', el('select', { onchange: e => reload2(e.target.value) }, j.exams.map(x => el('option', { value: x, selected: x === j.exam ? true : undefined }, x))), 
        has('report.export') ? el('button', { onclick: () => downloadCsv('/api/report/scores?exam=' + encodeURIComponent(j.exam), '成绩总表.csv') }, '导出CSV') : null),
      el('div', { id: 'sctable' })));
    reload2(j.exam);
  }
  async function reload2(ex) {
    if (!ex) return;
    const j = await api('/api/scores/list?exam=' + encodeURIComponent(ex));
    $('#sctable').replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '班级'), el('th', {}, '姓名'), el('th', {}, '科目'), el('th', {}, '分数'), has('score.edit') ? el('th', {}, '改分') : ''))),
      el('tbody', {}, j.rows.map(r => {
        const inp = el('input', { type: 'number', value: r.value, style: 'width:80px' });
        return el('tr', {}, el('td', {}, r.class_name || ''), el('td', {}, r.name), el('td', {}, r.subject),
          el('td', {}, String(r.value)), has('score.edit') ? el('td', {}, el('button', { class: 'sm', onclick: async () => {
            try { await api('/api/score/edit', { student_id: r.student_id, exam: r.exam, subject: r.subject, value: Number(inp.value) }); toast('已改'); } catch (e) { toast(e.message, true); }
          } }, '保存')) : null);
      })),
      j.rows.length ? null : el('div', { class: 'hint', style: 'margin-top:8px' }, '该考试暂无成绩'));
  }
  box.append(el('div', { class: 'card' }, el('h3', {}, '导入成绩'),
    el('div', { class: 'row' }, exam, subject, file),
    el('div', { class: 'row' }, c1, c2, el('span', { class: 'hint' }, '列号从 0 开始；留空=按表头自动找「身份证号」「成绩/分数」列')),
    el('button', { class: 'pri', onclick: async () => {
      const f = file.files[0]; if (!f) return toast('先选文件', true);
      if (!exam.value.trim() || !subject.value.trim()) return toast('考试名和科目必填', true);
      const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); });
      rep.replaceChildren(el('span', { class: 'muted' }, '导入中…'));
      try { const j = await api('/api/scores/import', { filename: f.name, b64, exam: exam.value, subject: subject.value, idcard_col: c1.value, value_col: c2.value });
        rep.replaceChildren(el('b', {}, `成功 ${j.ok} 条 / 共 ${j.total} 行`), ...j.errors.slice(0, 100).map(x => el('div', { class: 'err' }, `第 ${x.row} 行：${x.msg}`)));
        reload();
      } catch (e) { rep.replaceChildren(el('div', { class: 'err' }, e.message)); }
    } }, '导入'), rep), list);
  reload();
},
async departure(m) {
  m.append(...page('离校', '流程：开始离校 → 物资逐项收回 → 卫生检查通过 → 退押金（自动释放床位、状态改已离校）', el('div', { id: 'depbox' })));
  const box = $('#depbox'); const panel = el('div');
  async function show(sid) {
    const j = await api('/api/depart/detail', { student_id: sid });
    const s = j.student;
    if (!['在训', '请假中', '离校办理中'].includes(s.status)) { panel.replaceChildren(el('div', { class: 'card' }, `${s.name} 状态「${s.status}」，不能办理离校`)); return; }
    const body = [];
    if (s.status !== '离校办理中') {
      body.push(el('div', { class: 'row' }, el('button', { class: 'pri', onclick: async () => { try { await api('/api/depart/start', { student_id: sid }); show(sid); } catch (e) { toast(e.message, true); } } }, '开始离校办理')));
    } else {
      body.push(el('h3', {}, '① 物资收回'),
        el('table', {}, el('tbody', {}, j.supplies.length ? j.supplies.map(x => el('tr', {}, el('td', {}, x.name),
          el('td', {}, el('span', { class: 'tag ' + (x.status === '已还' ? 'green' : 'red') }, x.status)),
          el('td', {}, x.status !== '已还' ? el('button', { class: 'sm', onclick: async () => { try { await api('/api/depart/supply', { student_id: sid, item_id: x.item_id }); show(sid); } catch (e) { toast(e.message, true); } } }, '收回') : el('span', { class: 'muted' }, '✓')))) : el('tr', {}, el('td', { class: 'muted' }, '该生没有物资登记记录（视为无物资）')))),
        j.catalog.length && j.supplies.length < j.catalog.length ? el('div', { class: 'hint' }, '未登记的物资项不会阻塞退押金') : null,
        el('h3', { style: 'margin-top:12px' }, '② 卫生检查'),
        el('div', { class: 'row' }, j.departure.clean_ok ? el('span', { class: 'tag green' }, '检查通过 ✓') : el('span', { class: 'tag red' }, '未通过/未检查')),
        el('div', { class: 'row' }, el('input', { id: 'cleannote', placeholder: '检查备注', style: 'width:240px' }),
          el('button', { onclick: async () => { try { await api('/api/depart/clean', { student_id: sid, pass: true, note: $('#cleannote').value }); show(sid); } catch (e) { toast(e.message, true); } } }, '通过'),
          el('button', { class: 'dgr', onclick: async () => { try { await api('/api/depart/clean', { student_id: sid, pass: false, note: $('#cleannote').value }); show(sid); } catch (e) { toast(e.message, true); } } }, '不通过(返工)')),
        el('h3', { style: 'margin-top:12px' }, '③ 退押金'),
        el('div', { class: 'row' }, `原缴押金：${j.deposit ? j.deposit.amount + ' 元（' + (j.deposit.paid ? '已缴' : '未缴') + '）' : '未登记'}`),
        el('div', { class: 'row' }, '实退金额：', el('input', { id: 'refund', type: 'number', min: '0', step: '0.01', value: (j.deposit && j.deposit.amount) || 0, style: 'width:110px' }),
          el('span', { class: 'hint' }, '有扣损时改小金额并写备注'), el('input', { id: 'refundnote', placeholder: '扣款备注', style: 'width:180px' })),
        el('div', { class: 'row' }, j.departure.done ? el('span', { class: 'tag green' }, `已退 ${j.departure.refund} 元，离校完成 ✓`) :
          el('button', { class: 'pri', onclick: async () => {
            if (!(await askConfirm('确认退押金并完成离校？', '将自动释放床位、状态改为已离校；退押金不可重复操作', { danger: true, ok: '确认退押金' }))) return;
            try { await api('/api/depart/refund', { student_id: sid, refund: Number($('#refund').value) }); toast('离校完成'); show(sid); } catch (e) { toast(e.message, true); }
          } }, '确认退押金，完成离校')),
        j.dorm ? el('div', { class: 'hint' }, `当前宿舍：${j.dorm.building} ${j.dorm.floor}层 ${j.dorm.room}（退押金后自动释放）`) : null);
    }
    panel.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `${s.name}（${s.status}）`), ...body));
  }
  const sel = { id: null };
  box.append(el('div', { class: 'card' }, pickStudent('搜索学生…', s => { sel.id = s.id; show(s.id); })), panel);
},
async reports(m) {
  m.append(...page('报表', '', el('div', { id: 'repbox' })));
  const box = $('#repbox');
  const tabs = [['缴费汇总', '/api/report/fees'], ['报到情况', '/api/report/checkin'], ['宿舍占用', '/api/report/dorm'], ['成绩总表', '/api/report/scores'], ['缺勤名单', '/api/report/attendance']];
  let cur = tabs[0];
  const dateInput = el('input', { type: 'date', value: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) });
  dateInput.addEventListener('change', () => show(cur));
  async function show(t) {
    cur = t;
    const suffix = t[0] === '缺勤名单' ? (dateInput.value ? '?date=' + dateInput.value : '') : '';
    const j = await api(t[1] + suffix);
    const headsMap = {
      '缴费汇总': ['费项', '登记人数', '已缴人数', '已缴金额'],
      '报到情况': ['班级', '状态', '人数'],
      '宿舍占用': ['楼栋', '楼层', '宿舍', '性别', '住/床', '状态'],
      '成绩总表': ['考试', '科目', '班级', '姓名', '分数'],
      '缺勤名单': ['姓名', '班级', '性别', '状态'],
    };
    let rows = [];
    let statHtml = [];
    if (t[0] === '缴费汇总') {
      rows = j.items.map(x => [x.item, x.n, x.paid_n, x.paid_sum]);
      statHtml = j.byStatus.map(x => stat(x.n, x.status));
    } else if (t[0] === '报到情况') rows = j.rows.map(r => [r.class_name || '未分班', r.status, r.n]);
    else if (t[0] === '宿舍占用') rows = j.rows.map(r => [r.building, r.floor + '层', r.room, r.sex, `${r.used}/${r.beds}`, r.bad ? '坏' : '好']);
    else if (t[0] === '成绩总表') rows = j.rows.map(r => [r.exam, r.subject, r.class_name || '', r.name, r.value]);
    else if (t[0] === '缺勤名单') {
      rows = j.missing.map(r => [r.name, r.class_name || '未分班', r.sex, r.status]);
      statHtml = [stat(j.present, '出勤'), stat(j.total, '应到'), stat(j.leave, '请假'), stat(j.missing.length, '缺勤')];
    }
    const ths = (headsMap[t[0]] || []).map(h2 => el('th', {}, h2));
    const trs = rows.map(r => { const tr = el('tr', {}, r.map(c3 => el('td', {}, String(c3)))); return tr; });
    $('#repstat').replaceChildren(...statHtml);
    $('#reptable').replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ths)), el('tbody', {}, trs)),
      rows.length ? null : el('div', { class: 'hint', style: 'margin-top:8px' }, '本页无数据'));
  }
  const csvsel = has('report.export') ? el('select', { onchange: e => {
    const t2 = tabs[Number(e.target.value)];
    if (!t2) return;
    const extra = t2[0] === '缺勤名单' && dateInput.value ? '&date=' + dateInput.value : '';
    downloadCsv(t2[1] + '?format=csv' + extra, t2[0] + '.csv');
    e.target.value = '';
  } }, el('option', { value: '' }, '导出CSV…'), ...tabs.map((t2, i) => el('option', { value: i }, t2[0]))) : null;
  const btnRow = el('div', { class: 'row' }, ...tabs.map(t2 => el('button', { onclick: () => show(t2) }, t2[0])));
  const dateRow = el('div', { class: 'row', id: 'attedate', style: 'display:none' }, '日期：', dateInput);
  box.append(btnRow, dateRow, el('div', { id: 'repstat' }), el('div', { id: 'reptable' }));
  if (csvsel) btnRow.append(csvsel);
  const obs = new MutationObserver(() => { dateRow.style.display = cur[0] === '缺勤名单' ? '' : 'none'; });
  obs.observe($('#repstat'), { childList: true });
  show(cur);
},
async users(m) {
  m.append(...page('员工', '账号=手机号，初始密码=手机号后6位，首次登录强制改密；自助注册的账号也在这里激活', el('div', { id: 'userbox' })));
  const j = await api('/api/users');
  const posSel = () => el('select', {}, el('option', { value: '' }, '待激活（先不分岗）'),
    ...j.positions.filter(p => !p.system).map(p => el('option', { value: p.id }, p.name)));
  const rep = el('div');
  const name = el('input', { placeholder: '姓名', style: 'width:110px' });
  const phone = el('input', { placeholder: '手机号（11 位）', style: 'width:150px' });
  const sel1 = posSel();
  const file = el('input', { type: 'file', accept: '.xlsx,.csv,.txt' });
  $('#userbox').replaceChildren(
    el('div', { class: 'card' }, el('h3', {}, '新增员工'),
      el('div', { class: 'row' }, name, phone, sel1,
        el('button', { class: 'pri', onclick: async () => {
          try {
            const r = await api('/api/users/add', { name: name.value, phone: phone.value, position_id: sel1.value ? Number(sel1.value) : undefined });
            toast(`${r.msg}。账号 ${r.username}，初始密码 ${r.initpass}`);
            name.value = ''; phone.value = ''; sel1.value = '';
          } catch (e) { toast(e.message, true); }
        } }, '添加'))),
    el('div', { class: 'card' }, el('h3', {}, 'Excel 批量导入'),
      el('div', { class: 'row' }, el('a', { href: '/api/users/template' }, el('button', { type: 'button' }, '下载员工模板')), file,
        el('button', { class: 'pri', onclick: async () => {
          const f = file.files[0]; if (!f) return toast('先选文件', true);
          const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); });
          rep.replaceChildren(el('span', { class: 'muted' }, '导入中…'));
          try {
            const rr = await api('/api/users/import', { filename: f.name, b64 });
            rep.replaceChildren(el('div', {}, el('b', {}, `成功 ${rr.ok} 人（其中直接激活 ${rr.activated} 人，文件 ${rr.total} 行）`)),
              el('div', { class: 'hint' }, rr.msg),
              ...rr.errors.slice(0, 200).map(x => el('div', { class: 'err' }, `第 ${x.row} 行：${x.msg}`)));
          } catch (e2) { rep.replaceChildren(el('div', { class: 'err' }, e2.message)); }
        } }, '开始导入')),
      el('div', { class: 'hint' }, '岗位列填系统里已有的岗位名（如 前台/宿管）则直接激活；留空或岗位不存在则建为待激活'), rep),
    el('div', { class: 'card' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '账号'), el('th', {}, '姓名'), el('th', {}, '岗位'), el('th', {}, '状态'), el('th', {}, '操作'))),
      el('tbody', {}, j.users.map(u => {
        const sel = el('select', {}, j.positions.filter(p => !p.system || p.name === u.position).map(p => el('option', { value: p.id, selected: p.name === u.position }, p.name)));
        return el('tr', {}, el('td', { class: 'mono' }, u.username), el('td', {}, u.name), el('td', {}, u.position || '—'),
          el('td', {}, { active: el('span', { class: 'tag green' }, '在职'), pending: el('span', { class: 'tag orange' }, '待激活'), disabled: el('span', { class: 'tag red' }, '停用') }[u.status] || u.status),
          el('td', { class: 'nowrap' },
            u.status === 'pending' ? el('button', { class: 'pri sm', onclick: async () => { try { await api('/api/users/set', { id: u.id, action: 'activate', position_id: Number(sel.value) }); route(); } catch (e) { toast(e.message, true); } } }, '激活') : null,
            ' ', u.status !== 'pending' ? el('button', { class: 'sm', onclick: async () => { try { await api('/api/users/set', { id: u.id, action: 'setpos', position_id: Number(sel.value) }); toast('岗位已改'); } catch (e) { toast(e.message, true); } } }, '改岗位→') : null,
            ' ', u.status === 'active' ? el('button', { class: 'sm dgr', onclick: async () => { try { await api('/api/users/set', { id: u.id, action: 'disable' }); route(); } catch (e) { toast(e.message, true); } } }, '停用') : null,
            u.status === 'disabled' ? el('button', { class: 'sm', onclick: async () => { try { await api('/api/users/set', { id: u.id, action: 'enable' }); route(); } catch (e) { toast(e.message, true); } } }, '启用') : null,
            ' ', el('button', { class: 'sm', onclick: async () => { try { const r = await api('/api/users/reset-pass', { id: u.id }); (() => {
  const copy = el('sl-button', { slot: 'footer', variant: 'primary' }, '复制并关闭');
  const d = el('sl-dialog', { label: '密码已重置', style: '--width:380px' },
    el('div', { class: 'asktxt' }, '新密码（只显示这一次，请立即转交本人）：'),
    el('h2', { class: 'mono', style: 'user-select:all;letter-spacing:1px' }, r.password), copy);
  document.body.append(d);
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.password); toast('已复制到剪贴板'); } catch (e2) {} d.hide(); setTimeout(() => d.remove(), 400); });
  d.addEventListener('sl-hide', () => setTimeout(() => d.remove(), 400), { once: true });
  d.show();
})(); } catch (e) { toast(e.message, true); } } }, '重置密码')));
    })))));
},
async positions(m) {
  m.append(...page('岗位权限', '校长自定义岗位 = 勾选权限点 + 选择数据范围（校长是系统岗位，不可改）', el('div', { id: 'posbox' })));
  const j = await api('/api/positions');
  const PL = Array.isArray(j.permList) && j.permList.length && typeof j.permList[0] === 'object' ? j.permList : [];
  const box2 = $('#posbox');
  const editorBox = el('div');
  function editor(pos) {
    const perms = pos ? [...pos.perms] : [];
    const name = el('input', { value: pos ? pos.name : '', placeholder: '岗位名（如 副校长/前台/宿管）' });
    const radioName = 'sc' + (pos ? pos.id : 'n');
    const isAll = el('input', { type: 'radio', name: radioName }); isAll.checked = !pos || pos.scope.type === 'all';
    const isCls = el('input', { type: 'radio', name: radioName }); isCls.checked = !!pos && pos.scope.type === 'classes';
    const classes = el('input', { value: pos && pos.scope.classes ? pos.scope.classes.join(',') : '', placeholder: '临床一班,临床二班' });
    editorBox.replaceChildren(el('div', { class: 'card' }, el('h3', {}, pos ? '编辑：' + pos.name : '新建岗位'),
      el('div', { class: 'row' }, '岗位名：', name),
      el('div', { id: 'permgrid' }),
      el('div', { class: 'row', style: 'margin-top:10px' }, '数据范围：', el('label', {}, isAll, ' 全部学生 '), el('label', {}, isCls, ' 仅指定班级 '), classes,
        el('span', { class: 'hint' }, '(逗号分隔班级名)')),
      el('div', { class: 'row' }, el('button', { class: 'pri', onclick: async () => {
        const chosen = $$('#permgrid input:checked').map(i => i.value);
        if (!name.value.trim()) return toast('岗位名必填', true);
        const scope = isCls.checked ? { type: 'classes', classes: classes.value.split(/[,，、]/).map(x => x.trim()).filter(Boolean) } : { type: 'all' };
        try { await api('/api/positions/save', { id: pos ? pos.id : undefined, name: name.value, perms: chosen, scope }); toast('已保存'); route(); } catch (e) { toast(e.message, true); }
      } }, '保存'),
        el('button', { onclick: () => editorBox.replaceChildren() }, '取消'),
        pos && !pos.system ? el('button', { class: 'dgr', onclick: async () => {
          if (!(await askConfirm('删除岗位？', pos.name + '（需先移走该岗位上的员工）', { danger: true }))) return;
          try { await api('/api/positions/delete', { id: pos.id }); route(); } catch (e) { toast(e.message, true); }
        } }, '删除') : null)));
    const grid = $('#permgrid');
    for (const g of j.groups) {
      const items = PL.filter(p2 => p2.g === g);
      if (!items.length) continue;
      const toggle = el('button', { class: 'sm', onclick: () => {
        const boxes = items.map(p2 => $('#permgrid input[value="' + p2.k + '"]')).filter(Boolean);
        const allOn = boxes.every(b2 => b2.checked);
        boxes.forEach(b2 => { b2.checked = !allOn; });
        toggle.textContent = allOn ? '全选' : '清空';
      } }, '全选');
      grid.append(el('div', { class: 'row' }, el('label', { style: 'width:60px' }, g + '：'),
        ...items.map(p2 => el('label', { class: 'perm', style: 'margin-right:12px;font-size:13px' },
          el('input', { type: 'checkbox', value: p2.k, checked: perms.includes(p2.k) }), ' ' + p2.t)), toggle));
    }
    if (!PL.length) grid.append(el('div', { class: 'err' }, '权限点列表为空，请更新后端后刷新'));
  }
  const posRows = j.positions.map(p2 => {
    const editBtn = p2.system ? el('span', { class: 'muted' }, '系统岗位') : el('button', { class: 'sm', onclick: () => editor(p2) }, '编辑');
    return el('tr', {}, el('td', {}, p2.name), el('td', {}, String(p2.perms.length)),
      el('td', {}, p2.scope.type === 'all' ? '全部学生' : '班级:' + (p2.scope.classes || []).join(',')), el('td', {}, editBtn));
  });
  const posTable = el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, '岗位'), el('th', {}, '权限数'), el('th', {}, '范围'), el('th', {}, ''))),
    el('tbody', {}, posRows));
  box2.replaceChildren(editorBox, el('div', { class: 'card' }, posTable), el('button', { onclick: () => editor(null) }, '+ 新建岗位'));
},
async audit(m) {
  m.append(...page('审计日志', '所有涉钱、涉分、涉权限动作自动留痕，只增不改', el('div', { id: 'audbox' })));
  const j = await api('/api/audit?limit=500');
  $('#audbox').replaceChildren(
    el('div', { class: 'row' }, el('button', { onclick: () => downloadCsv('/api/audit?format=csv&limit=2000', '审计日志.csv') }, '导出CSV')),
    el('div', { class: 'card' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '时间'), el('th', {}, '操作人'), el('th', {}, '动作'), el('th', {}, '对象'), el('th', {}, '明细'))),
      el('tbody', {}, j.rows.map(r => el('tr', {}, el('td', { class: 'nowrap muted' }, fmtDT(r.at)), el('td', {}, r.user), el('td', {}, r.action), el('td', { class: 'mono' }, r.target), el('td', { class: 'muted' }, r.detail)))))));
},
};
/* ---------- 密码强度 ---------- */
function pwScore(v) {
  v = String(v || '');
  if (v.length < 8) return 0;
  const cls = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(v)).length;
  let s = cls <= 1 ? 1 : (cls === 2 ? 2 : 3);
  if (v.length >= 12) s++;
  if (/(1234|qwer|asdf|zxcv|abcd|password|admin|lenen|8888|0000|1122|2026)/i.test(v)) s--;
  return Math.max(0, Math.min(4, s));
}
/* ---------- 改密码（防御式：要求提前明示，组件异常可降级） ---------- */
async function renderChangePW(first) {
  const ready = await slReady();
  const mk = (attrs) => ready ? el('sl-input', attrs) : el('input', { placeholder: attrs.label + '：' + (attrs.placeholder || ''), type: attrs.type || 'text', autocomplete: attrs.autocomplete || '', 'aria-label': attrs.label, required: true });
  const o = mk({ name: 'o', type: 'password', label: '当前密码', placeholder: '区分大小写；若一直提示不对，检查中英文输入法和大写锁定', autocomplete: 'current-password' });
  const n1 = mk({ name: 'n1', type: 'password', label: '新密码', placeholder: '要求：至少 8 位；建议 12 位以上、字母+数字+符号混合', autocomplete: 'new-password' });
  const n2 = mk({ name: 'n2', type: 'password', label: '确认新密码', placeholder: '需与上面完全一致', autocomplete: 'new-password' });
  const meter = el('div', { class: 'pw-meter' }, el('i'), el('i'), el('i'), el('i'));
  const meterTxt = el('div', { class: 'hint', style: 'min-height:18px;margin-bottom:8px' }, '输入新密码后这里显示强度');
  const lvNames = ['', '太弱：很容易被猜到', '较弱：建议加长或混入符号', '不错：中等强度', '强：很好的密码'];
  function refresh() {
    try {
      const v = slVal(n1);
      const sc = pwScore(v);
      if (sc > 0) meter.dataset.lv = String(sc); else meter.removeAttribute('data-lv');
      meterTxt.textContent = !v ? '输入新密码后这里显示强度' : (v.length < 8 ? '太短：至少 8 位' : lvNames[sc]);
      if (ready) {
        const bad = slVal(n2).length > 0 && v !== slVal(n2);
        n2.helpText = bad ? '两次输入不一致，请检查' : '';
        if (bad) n2.setAttribute('data-invalid', ''); else n2.removeAttribute('data-invalid');
      }
    } catch (e) { /* 强度计算永不阻塞输入 */ }
  }
  ['sl-input', 'input', 'keyup'].forEach(ev => { try { n1.addEventListener(ev, refresh); n2.addEventListener(ev, refresh); } catch (e) {} });
  $('#app').replaceChildren(el('div', { class: 'login-wrap' }, el('form', { class: 'login-box animate__animated animate__fadeInUp', onsubmit: async e => {
    e.preventDefault();
    const oldPw = slVal(o), np = slVal(n1), np2 = slVal(n2);
    if (oldPw.length === 0) return toast('请先输入当前密码', true);
    if (np.length < 8) return toast('新密码至少 8 位', true);
    if (np !== np2) return toast('两次输入的新密码不一致，请重新核对', true);
    if (pwScore(np) < 2) {
      const go = await askConfirm('密码强度偏低', '这个密码容易被猜到。确认仍要使用吗？', { danger: true, ok: '仍要使用' });
      if (!go) return;
    }
    try {
      await api('/api/my/password', { old: oldPw, new: np });
      // 醒目成功页（纯 DOM，不依赖任何组件库，绝不失败）
      ME.must_change = false;
      const go = el('button', { class: 'pri', style: 'width:100%;margin-top:14px;padding:10px' }, '继 续');
      go.addEventListener('click', () => {
        try { if (first) afterLogin(); else route(); }
        catch (e4) { location.reload(); } // 导航异常时刷新兜底（此时 must_change 已 false，直接进系统）
      });
      $('#app').replaceChildren(el('div', { class: 'login-wrap' }, el('div', { class: 'login-box', style: 'text-align:center' },
        el('div', { style: 'font-size:44px;margin-bottom:6px' }, '✅'),
        el('h1', {}, '密码修改成功'),
        el('div', { class: 'sub', style: 'margin-top:8px' }, '新密码已生效，下次登录请使用【新密码】'),
        el('div', { class: 'hint' }, '当前会话保持登录。请务必牢记新密码！'),
        go)));
      return;
    } catch (e2) {
      const m = String(e2.message || '');
      if (/is not defined|Cannot read|fetch|network/i.test(m)) toast('页面组件加载异常：请按 Ctrl+F5 强制刷新后重试', true);
      else toast(m + '（原密码不对：请检查大小写、中英文输入法、大写锁定）', true);
    }
  } },
    el('h1', {}, first ? '首次登录，请改密码' : '修改密码'),
    el('div', { class: 'sub' }, first ? '为安全起见，先设置你自己的密码' : ''),
    el('div', { class: 'hint', style: 'margin-bottom:10px' }, '密码要求：至少 8 位，建议字母+数字+符号混合，两次输入需一致，密码区分大小写'),
    o, n1, meter, meterTxt, n2,
    ready ? el('sl-button', { type: 'submit', variant: 'primary', size: 'large', style: 'width:100%;margin-top:6px' }, '保存新密码')
          : el('button', { type: 'submit', class: 'pri', style: 'width:100%;margin-top:6px;padding:10px' }, '保存新密码'),
    first ? null : el('sl-button', { type: 'button', variant: 'default', style: 'width:100%;margin-top:8px', onclick: () => route() }, '取消'),
  )));
  refresh();
}
/* ---------- 启动 ---------- */
(async function boot() {
  try { const j = await api('/api/me'); ME = j.user; VER = j.version || ''; afterLogin(); }
  catch { renderLogin(); }
})();
