/* 面试 / 谈判陪练官 —— 主逻辑 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clampScore = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
  };
  /* 维度完全没被触及时模型会给 null，不参与总分 */
  const dimScore = (v) => (v === null || v === undefined || v === '' || String(v).toLowerCase() === 'null') ? null : clampScore(v);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const state = {
    cfg: { scene: 'campus', job: '辩论社', round: 'club', pressure: 'standard', persona: '社团部长（学长）', total: 7, background: '', focus: '', mode: 'practice', limit: 90, brief: { times: '', prep: '', mood: '', tone: '' } },
    turns: [],
    qIndex: 0,
    startedAt: 0,
    timerId: null,
    qTimerId: null,
    qStartedAt: 0,
    streaming: false,
    abort: null,
    report: null,
    savedId: null,
    modelId: null,
    user: null,
    drill: null,
    screen: 'setup',
    pendingSave: false,
    files: [],
    presets: [],
    presetsLoaded: false,
    favSet: {},
    pendingFav: null,
    plan: [],
    planGaps: [],
    sub: 0,
    fuPlan: 0,
    fuTotal: 0,
    replanned: false,
    usedStyles: [],
    lastShapes: [],
    patience: 0
  };

  const MODES = {
    practice: { label: '练习模式', note: '不限时。想清楚再说，重点是把结构讲顺。' },
    real: { label: '实战模式', note: '每题倒计时，到点自动提交。真考场不会等你。' }
  };
  const LIMITS = [60, 90, 120, 180];

  let cloud = null;

  /* ================= 云客户端 ================= */
  function initCloud() {
    const cfg = window.WB_CLOUD_CONFIG;
    const lib = window.WorkBuddyCloud;
    if (!lib || !cfg) return null;
    cloud = lib.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
      publishableKey: cfg.publishableKey
    });
    return cloud;
  }

  function llmErrorMessage(err) {
    const code = (err && err.error && err.error.code) || '';
    const msg = (err && err.error && err.error.message) || (err && err.message) || '';
    if (code.indexOf('quota_') === 0) return '模型额度暂时用完了，稍后再试。';
    if (code.indexOf('auth_') === 0) return '模型服务鉴权失败。请在应用正式发布后的域名下使用。';
    if (code.indexOf('request_') === 0) return '请求被拒绝：' + msg;
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，再试一次。';
    return '调用失败：' + (msg || '未知错误');
  }

  async function ensureModel() {
    if (state.modelId) return state.modelId;
    if (!cloud) throw new Error('云服务未就绪');
    const models = await cloud.llm.models.list();
    const usable = (models || []).filter((m) => m && m.disabled !== true && m.enabled !== false);
    if (!usable.length) throw new Error('模型服务暂不可用（模型列表为空）');
    const prefer = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'hy3'];
    let picked = null;
    for (const id of prefer) {
      picked = usable.find((m) => m.id === id);
      if (picked) break;
    }
    state.modelId = (picked || usable[0]).id;
    return state.modelId;
  }

  async function streamChat(opts) {
    const model = await ensureModel();
    const controller = new AbortController();
    state.abort = controller;
    let text = '';
    try {
      const req = {
        model,
        messages: opts.messages,
        stream: true,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 1,
        signal: controller.signal
      };
      if (opts.json) req.response_format = { type: 'json_object' };
      for await (const chunk of cloud.llm.chat.completions.create(req)) {
        const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) {
          text += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content, text);
        }
      }
      return text;
    } finally {
      state.abort = null;
    }
  }

  function parseJSONLoose(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b === -1 || b <= a) return null;
    const body = s.slice(a, b + 1);
    try { return JSON.parse(body); } catch (e) { /* 尝试去尾逗号 */ }
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
  }

  async function requestJSON(system, user, temperature) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let raw = await streamChat({ messages, json: true, temperature: temperature || 0.6 });
    let data = parseJSONLoose(raw);
    if (!data) {
      const retry = await streamChat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
          { role: 'assistant', content: raw || '（空）' },
          { role: 'user', content: '上面这段不是合法 JSON。请重新只输出一个合法的 JSON 对象，不要任何其他文字，不要代码块。' }
        ],
        json: true,
        temperature: 0.4
      });
      data = parseJSONLoose(retry);
    }
    if (!data) throw new Error('评分结果解析失败，请重试');
    return data;
  }

  /* ================= 屏幕切换 ================= */
  const MASCOT = {
    campus: 'assets/mascot-duck.jpg',
    academic: 'assets/mascot-doctor.jpg',
    graduate: 'assets/mascot-doctor.jpg',
    career: 'assets/mascot-ball.jpg',
    civil: 'assets/mascot-grad.jpg',
    thesis: 'assets/mascot-grad.jpg'
  };
  function mascotFor() {
    const sc = sceneOfRound(state.cfg.round);
    return MASCOT[sc && sc.key] || MASCOT.campus;
  }

  function goHome() {
    if (state.screen === 'room') {
      const answered = state.turns.filter((t) => t.role === 'candidate').length;
      if (answered > 0 && !window.confirm('回选择台会丢掉这一轮对话，确定吗？')) return;
    }
    if (state.streaming && state.abort) { try { state.abort.abort(); } catch (e) {} }
    state.streaming = false;
    stopTimer();
    stopQuestionTimer();
    if (voice.listening || voice.wantListening) voice.stop();
    if (drillVoice.listening || drillVoice.wantListening) drillVoice.stop();
    show('setup');
    renderSetup();
  }

  function show(name) {
    ['setup', 'room', 'report', 'drill', 'history', 'saved'].forEach((k) => {
      const el = $('screen-' + k);
      if (el) el.classList.toggle('hidden', k !== name);
    });
    state.screen = name;
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.toggle('err', !!isErr);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }


  /* ================= 语音输入 ================= */
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const VOICE_OK = !!SpeechRec;

  const mmss = (sec) => String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');

  function countWords(text, lang) {
    const t = String(text || '').trim();
    if (!t) return 0;
    if (String(lang).indexOf('en') === 0) {
      return t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    }
    return t.replace(/[\s\p{P}]/gu, '').length;
  }

  function voiceLang() { return currentRound().lang === 'en' ? 'en-US' : 'zh-CN'; }

  // 预览面板是 iframe，没给 allow="microphone" 时浏览器会直接拒绝，连授权弹窗都不出
  function inFrame() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }

  function micBlockedMsg() {
    const u = uaInfo();
    if (u.inApp) {
      return '内置浏览器（微信 / QQ / 钉钉这类）不给网页用麦克风：点右上角「…」→ 在浏览器打开；或直接用输入法的语音键。';
    }
    if (inFrame()) {
      return '预览窗口拿不到麦克风：点右上角「在浏览器中打开」，再用话筒。';
    }
    if (u.ios) {
      return 'Safari 没给麦克风：点地址栏左侧「大小」图标 → 网站设置 → 麦克风选允许；仍不行就去 设置 → Safari 里放开麦克风。';
    }
    if (u.android) {
      return 'Chrome 没给麦克风：点地址栏左侧的图标 → 权限 → 麦克风改成允许，然后刷新。';
    }
    return '浏览器拦了麦克风：点地址栏最左边的图标 → 网站设置 → 把“麦克风”改成允许，再刷新页面。';
  }

  function uaInfo() {
    const ua = navigator.userAgent || '';
    return {
      ios: /iPhone|iPad|iPod/i.test(ua),
      android: /Android/i.test(ua),
      inApp: /MicroMessenger|QQ\/|QQBrowser|DingTalk|Weibo|Feishu|Lark|AlipayClient|WorkBuddy/i.test(ua),
      mobile: /iPhone|iPad|iPod|Android|Mobile/i.test(ua)
    };
  }

  function micServiceMsg() {
    return uaInfo().mobile
      ? '这台手机的浏览器连不上语音识别服务：换 Safari / Edge 打开，或直接用输入法的语音键说。'
      : '浏览器的语音识别服务用不了：Chrome 走 Google 的识别，境内常连不上，换 Edge 再试。';
  }

  function VoiceField(opts) {
    this.btn = opts.btn;
    this.input = opts.input;
    this.barEl = opts.barEl || null;
    this.stateEl = opts.stateEl || null;
    this.langEl = opts.langEl || null;
    this.getLang = opts.getLang;
    this.rec = null;
    this.listening = false;
    this.wantListening = false;
    this.errorStop = false;
    this.base = '';
    this.finalText = '';
    this.interim = '';
    this.startedAt = 0;
    this.seconds = 0;
    this.words = 0;
    this.accSec = 0;
    this.accWords = 0;
    this.confSum = 0;
    this.confN = 0;
    this.sessionCounted = false;
    this.ticker = null;
  }

  VoiceField.prototype.setup = function () {
    if (!VOICE_OK || !this.btn) { if (this.btn) this.btn.classList.add('hidden'); return; }
    const self = this;
    this.btn.addEventListener('click', () => self.toggle());
    if (inFrame()) this.btn.title = '预览窗口拿不到麦克风，请在浏览器中打开';
  };

  VoiceField.prototype.toggle = function () {
    if (this.listening || this.wantListening) this.stop();
    else this.start();
  };

  VoiceField.prototype.start = function () {
    if (!VOICE_OK || this.wantListening) return;
    const self = this;
    const lang = this.getLang();
    const rec = new SpeechRec();
    this.rec = rec;
    rec.lang = lang;
    const mobile = uaInfo().mobile;
    rec.continuous = !mobile; // 手机上 continuous 不生效，靠点第二次继续
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const joiner = lang.indexOf('en') === 0 ? ' ' : '';
    this.base = this.input.value.trim() ? this.input.value.replace(/\s+$/, '') + joiner : '';
    this.finalText = '';
    this.interim = '';
    this.accSec = this.seconds;
    this.accWords = this.words;
    this.sessionCounted = false;
    this.startedAt = 0;
    this.wantListening = true;
    this.errorStop = false;

    rec.onstart = () => {
      self.listening = true;
      if (!self.startedAt) self.startedAt = Date.now();
      self.paint();
      clearInterval(self.ticker);
      self.ticker = setInterval(() => self.paint(), 1000);
    };

    rec.onresult = (e) => {
      let add = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0] ? r[0].transcript : '';
        if (r.isFinal) {
          add += txt;
          /* 识别置信度：发音含糊、吞音、连读糊在一起时，这里的值会低。是发音清晰度的间接信号 */
          const c = r[0] && Number(r[0].confidence);
          if (c > 0 && c <= 1) { self.confSum += c; self.confN += 1; }
        } else interim += txt;
      }
      if (add) {
        self.finalText += add;
        self.words = self.accWords + countWords(self.finalText, lang);
      }
      self.interim = interim;
      self.input.value = (self.base + self.finalText + interim).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
      self.paint();
    };

    rec.onerror = (e) => {
      const err = (e && e.error) || '';
      if (err === 'not-allowed') {
        self.errorStop = true;
        self.wantListening = false;
        toast(micBlockedMsg(), true);
      } else if (err === 'service-not-allowed') {
        self.errorStop = true;
        self.wantListening = false;
        toast(micServiceMsg(), true);
      } else if (err === 'audio-capture') {
        self.errorStop = true;
        self.wantListening = false;
        toast('没找到麦克风设备，检查一下耳机或系统输入。', true);
      } else if (err === 'network') {
        toast(uaInfo().mobile ? '语音识别连不上服务器：换 Safari / Edge 或换个网络，再点一次话筒。' : '语音识别连不上服务器：换 Edge 或换个网络，再点一次话筒。', true);
      }
      if (self.errorStop) self.finish();
    };

    rec.onend = () => {
      // 桌面 Chrome 静音几秒会自动收尾，还在听就接上；手机上重新 start 常要用户手势，交给用户再点
      if (self.wantListening && !self.errorStop && !mobile) {
        setTimeout(() => {
          if (!self.wantListening) return;
          try { rec.start(); } catch (e) { self.finish(); }
        }, 260);
        return;
      }
      self.finish();
    };

    try { rec.start(); } catch (e) { toast('语音没启动起来，再点一次试试', true); }
    // 等浏览器弹麦克风授权时也先给出反馈，别让人以为按钮没反应
    this.paint();
  };

  VoiceField.prototype.stop = function () {
    this.wantListening = false;
    if (this.rec) { try { this.rec.stop(); } catch (e) {} }
    this.finish();
  };

  VoiceField.prototype.finish = function () {
    this.listening = false;
    this.wantListening = false;
    clearInterval(this.ticker);
    this.ticker = null;
    if (!this.sessionCounted && this.startedAt) {
      const delta = Math.round((Date.now() - this.startedAt) / 1000);
      this.accSec = (this.accSec || 0) + (delta > 0 ? delta : 0);
      this.sessionCounted = true;
    }
    this.seconds = this.accSec || 0;
    if (this.finalText || this.interim) {
      const add = countWords(this.finalText + ' ' + this.interim, this.rec ? this.rec.lang : 'zh-CN');
      this.words = (this.accWords || 0) + add;
    }
    this.paint();
  };

  VoiceField.prototype.reset = function () {
    this.base = '';
    this.finalText = '';
    this.interim = '';
    this.startedAt = 0;
    this.seconds = 0;
    this.words = 0;
    this.accSec = 0;
    this.accWords = 0;
    this.confSum = 0;
    this.confN = 0;
    this.sessionCounted = false;
    this.paint();
  };

  /* 平均识别置信度（0–1）。不是音色分析，只是“机器听不听得清”的间接刻度 */
  VoiceField.prototype.conf = function () {
    return this.confN >= 2 ? this.confSum / this.confN : 0;
  };

  VoiceField.prototype.used = function () {
    return this.seconds >= 3 && this.words > 0;
  };

  VoiceField.prototype.paint = function () {
    const on = this.listening || this.wantListening;
    if (this.btn) this.btn.classList.toggle('rec', on);
    const label = this.btn ? this.btn.querySelector('.mic-txt') : null;
    const secs = on && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : this.seconds;
    if (label) label.textContent = on ? mmss(secs) : '说';
    if (this.barEl) this.barEl.classList.toggle('hidden', !on);
    if (this.langEl) this.langEl.textContent = this.getLang().indexOf('en') === 0 ? 'EN' : '中文';
    if (on && this.stateEl) {
      const unit = this.getLang().indexOf('en') === 0 ? '词' : '字';
      this.stateEl.textContent = '正在听 · ' + mmss(secs) + (this.words ? ' · ' + this.words + ' ' + unit : '');
    }
  };

  const voice = new VoiceField({
    btn: $('btnMic'), input: $('answerInput'),
    barEl: $('voiceBar'), stateEl: $('voiceState'), langEl: $('voiceLang'),
    getLang: voiceLang
  });
  const drillVoice = new VoiceField({
    btn: $('btnDrillMic'), input: $('drillInput'), getLang: voiceLang
  });

  /* ================= 选择台 ================= */
  function currentScene() { return SCENE_MAP[state.cfg.scene] || SCENES[0]; }
  function currentRound() { return ROUNDS[state.cfg.round] || ROUNDS[currentScene().rounds[0]]; }

  function renderSummary() {
    const s = currentScene();
    const r = currentRound();
    const p = PRESSURES[state.cfg.pressure] || PRESSURES.standard;
    $('startSummary').innerHTML =
      '<b>' + esc(state.cfg.job) + '</b> · ' + esc(s.label) + ' / ' + esc(r.label) +
      ' · ' + esc(p.label) +
      ' · ' + state.cfg.total + ' 题' + (r.noFollowup ? '' : '（每题最多追问 ' + p.fu + ' 层）') +
      ' · ' + esc(state.cfg.persona) +
      ' · ' + esc(state.cfg.mode === 'real' ? '实战 ' + state.cfg.limit + ' 秒/题' : '练习') +
      (function () {
        const b = (typeof briefOf === 'function') ? briefOf(state.cfg) : {};
        const bits = ['times', 'prep', 'mood', 'tone']
          .map((k) => (b[k] && typeof BRIEF_TEXT !== 'undefined' ? BRIEF_TEXT[k][b[k]] : ''))
          .filter(Boolean);
        return bits.length ? '<span class="sum-brief"> · ' + esc(bits.join(' / ')) + '</span>' : '';
      })();
  }

  /* 面试前那张小问卷：四个一选一，点一下就有、再点一下取消 */
  function renderBrief() {
    const grid = $('briefGrid');
    if (!grid || typeof BRIEF_FIELDS === 'undefined') return;
    if (!state.cfg.brief) state.cfg.brief = { times: '', prep: '', mood: '', tone: '' };
    grid.innerHTML = '';
    BRIEF_FIELDS.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'brief-row';
      const lab = document.createElement('span');
      lab.className = 'brief-label';
      lab.textContent = f.label;
      row.appendChild(lab);
      const chips = document.createElement('div');
      chips.className = 'chips';
      f.opts.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip' + (state.cfg.brief[f.key] === o.k ? ' on' : '');
        b.textContent = o.t;
        b.onclick = () => {
          state.cfg.brief[f.key] = state.cfg.brief[f.key] === o.k ? '' : o.k;
          renderBrief();
          renderSummary();
        };
        chips.appendChild(b);
      });
      row.appendChild(chips);
      grid.appendChild(row);
    });
    const n = ['times', 'prep', 'mood', 'tone'].filter((k) => state.cfg.brief[k]).length;
    const note = $('briefNote');
    if (note) {
      note.textContent = n === 0
        ? '点完这几下，它会按你的情况问：第一次来，就不会拿“你了解我们哪场活动”卡你。不填也行。'
        : (n === 4
          ? '四个都填了。它按这个来：问什么、怎么问、给不给台阶。'
          : '已经 ' + n + ' 个，还差 ' + (4 - n) + ' 个（不填也行）。');
    }
  }

  function renderSetup() {
    const scene = currentScene();
    const round = currentRound();

    /* 01 场景 */
    const sg = $('sceneGrid');
    sg.innerHTML = '';
    SCENES.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'scene-card' + (state.cfg.scene === s.key ? ' on' : '');
      b.innerHTML = '<b>' + esc(s.label) + '</b><span>' + esc(s.tags || '') + '</span>';
      b.onclick = () => {
        state.cfg.scene = s.key;
        const first = ROUNDS[s.rounds[0]];
        state.cfg.round = s.rounds[0];
        state.cfg.job = s.subjects[0] === '自定义' ? '自定义' : s.subjects[0];
        state.cfg.persona = first.personas[0];
        state.cfg.total = (first.counts && first.counts.indexOf(7) !== -1) ? 7 : (first.counts ? first.counts[first.counts.length - 1] : 7);
        $('jobCustom').value = '';
        renderSetup();
      };
      sg.appendChild(b);
    });
    $('sceneDesc').innerHTML = '<b>' + esc(scene.en) + '</b>' + esc(scene.desc);

    /* 02 具体类型 */
    const grid = $('roundGrid');
    grid.innerHTML = '';
    scene.rounds.forEach((k) => {
      const r = ROUNDS[k];
      const b = document.createElement('button');
      b.className = 'round-card' + (state.cfg.round === k ? ' on' : '');
      b.innerHTML = '<b>' + esc(r.label) + '</b><span>' + esc(r.short || r.tagline) + '</span>';
      b.onclick = () => {
        state.cfg.round = k;
        state.cfg.persona = r.personas[0];
        const cs = r.counts || [5, 7, 9];
        if (cs.indexOf(state.cfg.total) === -1) state.cfg.total = cs.indexOf(7) !== -1 ? 7 : cs[cs.length - 1];
        renderSetup();
      };
      grid.appendChild(b);
    });

    /* 本轮会发生什么 */
    const flow = (round.flow || []).map((f, i) =>
      '<span><i>' + (i + 1) + '</i>' + esc(f) + '</span>').join('');
    const pNow = PRESSURES[state.cfg.pressure] || PRESSURES.standard;
    $('roundPreview').innerHTML =
      '<div class="rp-flow">' + flow + '</div>' +
      '<div class="rp-fu">每道题最多追 <b>' + pNow.fu + '</b> 层 · ' + esc(pNow.fuShort) +
        (round.noFollowup ? '（这一轮是题本面试，按规矩不追问）' : '') + '</div>' +
      (round.lang === 'en'
        ? '<div class="rp-voice">' + (VOICE_OK
            ? '这一轮可以开口答：进场后点输入框旁的“说”，直接讲英语，转写出来的文字还能改。语言本身也计分——语法、用词，以及开口说时的语速和清晰度。'
            : '这一轮是全英文。当前浏览器不支持语音输入，换成 Chrome 或 Edge 才能开口练；打字作答时，语言质量照样计分。') + '</div>'
        : '') +
      (round.tip ? '<div class="rp-tip"><b>这一轮怎么准备</b>' + esc(round.tip) + '</div>' : '');

    /* 03 对象 */
    $('subjectLabel').textContent = scene.subjectLabel || '岗位';
    $('jobCustom').placeholder = '具体一点，例如：' + (scene.subjectExample || scene.subjectLabel || '岗位');
    const jobChips = $('jobChips');
    jobChips.innerHTML = '';
    const isCustom = scene.subjects.indexOf(state.cfg.job) === -1;
    scene.subjects.forEach((j) => {
      const b = document.createElement('button');
      b.className = 'chip' + ((state.cfg.job === j || (j === '自定义' && isCustom)) ? ' on' : '');
      b.textContent = j;
      b.onclick = () => {
        if (j === '自定义') {
          state.cfg.job = $('jobCustom').value.trim() || '自定义';
          $('jobCustom').classList.remove('hidden');
          $('jobCustom').focus();
        } else {
          state.cfg.job = j;
          $('jobCustom').classList.add('hidden');
        }
        renderSetup();
      };
      jobChips.appendChild(b);
    });
    $('jobCustom').classList.toggle('hidden', !(isCustom || state.cfg.job === '自定义'));
    if (isCustom && !$('jobCustom').value && state.cfg.job !== '自定义') $('jobCustom').value = state.cfg.job;

    /* 04 压力与节奏 */
    const pseg = $('pressureSeg');
    pseg.innerHTML = '';
    Object.keys(PRESSURES).forEach((k) => {
      const b = document.createElement('button');
      b.className = state.cfg.pressure === k ? 'on' : '';
      b.textContent = PRESSURES[k].label;
      b.onclick = () => { state.cfg.pressure = k; renderSetup(); };
      pseg.appendChild(b);
    });

    const counts = round.counts || [5, 7, 9];
    if (counts.indexOf(state.cfg.total) === -1) state.cfg.total = counts[0];
    const cseg = $('countSeg');
    cseg.innerHTML = '';
    counts.forEach((n) => {
      const b = document.createElement('button');
      b.className = state.cfg.total === n ? 'on' : '';
      b.textContent = n + ' 题';
      b.onclick = () => { state.cfg.total = n; renderSetup(); };
      cseg.appendChild(b);
    });

    const sel = $('personaSelect');
    const personas = round.personas;
    if (personas.indexOf(state.cfg.persona) === -1) state.cfg.persona = personas[0];
    sel.innerHTML = '';
    personas.forEach((p) => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      if (p === state.cfg.persona) o.selected = true;
      sel.appendChild(o);
    });

    /* 05 模式 */
    const mseg = $('modeSeg');
    mseg.innerHTML = '';
    Object.keys(MODES).forEach((k) => {
      const b = document.createElement('button');
      b.className = state.cfg.mode === k ? 'on' : '';
      b.textContent = MODES[k].label;
      b.onclick = () => { state.cfg.mode = k; renderSetup(); };
      mseg.appendChild(b);
    });
    $('modeNote').textContent = MODES[state.cfg.mode] ? MODES[state.cfg.mode].note : '';
    $('limitRow').classList.toggle('hidden', state.cfg.mode !== 'real');
    const lsel = $('limitSelect');
    lsel.innerHTML = '';
    LIMITS.forEach((n) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + ' 秒';
      if (Number(state.cfg.limit) === n) o.selected = true;
      lsel.appendChild(o);
    });
    if (LIMITS.indexOf(Number(state.cfg.limit)) === -1) state.cfg.limit = 90;

    /* 06 背景材料 */
    $('bgLabel').innerHTML = esc(scene.bgLabel || '背景材料') + '<span class="opt">可选</span>';
    $('bgInput').placeholder = scene.bgPlaceholder || '';
    if ($('focusInput')) $('focusInput').value = state.cfg.focus || '';
    if ($('bgInput').value !== (state.cfg.background || '')) $('bgInput').value = state.cfg.background || '';
    renderFileChips();
    renderBrief();

    renderPresetBar();
    renderSummary();
  }

  function bindSetup() {
    $('jobCustom').addEventListener('input', (e) => {
      state.cfg.job = e.target.value.trim() || '自定义';
      renderSummary();
    });
    $('personaSelect').addEventListener('change', (e) => {
      state.cfg.persona = e.target.value;
      renderSetup();
    });
    $('bgInput').addEventListener('input', (e) => { state.cfg.background = e.target.value; });
    $('focusInput').addEventListener('input', (e) => { state.cfg.focus = e.target.value; });
    $('limitSelect').addEventListener('change', (e) => {
      state.cfg.limit = Number(e.target.value) || 90;
      renderSummary();
    });
    $('btnStart').addEventListener('click', startInterview);
    if ($('btnMeme')) $('btnMeme').addEventListener('click', playMeme);
    $('btnHistory').addEventListener('click', openHistory);
    $('btnSaved').addEventListener('click', openSaved);
    $('btnBackHome').addEventListener('click', goHome);
    $('btnBackHome2').addEventListener('click', goHome);
    const brand = document.querySelector('.brand');
    if (brand) {
      brand.style.cursor = 'pointer';
      brand.title = '回到选择台';
      brand.addEventListener('click', goHome);
    }

    /* 材料上传 */
    $('btnUpload').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      handleFiles(e.target.files);
      e.target.value = '';
    });
    const block = $('bgInput').closest('.block');
    if (block) {
      ['dragenter', 'dragover'].forEach((ev) => block.addEventListener(ev, (e) => {
        e.preventDefault();
        block.classList.add('drop-on');
      }));
      ['dragleave', 'drop'].forEach((ev) => block.addEventListener(ev, (e) => {
        e.preventDefault();
        block.classList.remove('drop-on');
      }));
      block.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      });
    }

    /* 我的配置 */
    $('presetBar').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'btnSavePreset2') { savePreset(); return; }
      if (btn.id === 'btnPresetLogin') { openAuth(); return; }
      const item = btn.closest('.pb-item');
      if (!item) return;
      if (btn.dataset.act === 'load') loadPreset(item.dataset.id);
      else if (btn.dataset.act === 'del') deletePreset(item.dataset.id, item.dataset.name);
    });
    $('presetBar').addEventListener('input', (e) => {
      if (e.target.id === 'presetName') state.presetName = e.target.value;
    });
  }

  /* ================= 材料文件 ================= */
  const FILE_MAX = 6000;

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsText(file, 'utf-8');
    });
  }

  async function unzipText(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 docx');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nlen = dv.getUint16(off + 28, true);
      const elen = dv.getUint16(off + 30, true);
      const clen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      if (name === 'word/document.xml') {
        if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('docx 结构异常');
        const lnlen = dv.getUint16(lho + 26, true);
        const lelen = dv.getUint16(lho + 28, true);
        const start = lho + 30 + lnlen + lelen;
        const data = u8.subarray(start, start + csize);
        if (method === 0) return new TextDecoder().decode(data);
        if (method !== 8) throw new Error('docx 压缩格式不支持');
        if (typeof DecompressionStream === 'undefined') throw new Error('浏览器太旧，解不开 docx');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(stream).text();
      }
      off += 46 + nlen + elen + clen;
    }
    throw new Error('docx 里没有正文');
  }

  function docxToText(xml) {
    return xml
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function readMaterial(file) {
    const name = (file.name || '').toLowerCase();
    if (/\.docx$/.test(name)) {
      const buf = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('读取失败'));
        fr.readAsArrayBuffer(file);
      });
      return docxToText(await unzipText(buf));
    }
    if (/\.(txt|md|markdown|csv|json|text)$/.test(name) || /^text\//.test(file.type || '')) {
      return await readAsText(file);
    }
    if (/\.pdf$/.test(name)) throw new Error('PDF 读不了：先另存为 txt，或把要点复制粘贴进来');
    throw new Error('这个格式还不支持：用 txt / md / csv / docx');
  }

  async function handleFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    for (const f of files) {
      if (f.size > 4 * 1024 * 1024) { toast(f.name + ' 超过 4MB，截一部分再传', true); continue; }
      try {
        let text = await readMaterial(f);
        text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) { toast(f.name + ' 里没读到文字', true); continue; }
        const cur = $('bgInput').value;
        const room = FILE_MAX - cur.length;
        if (room < 40) { toast('材料已经够长了，先删一点再加', true); break; }
        const clipped = text.length > room ? text.slice(0, room) : text;
        const blockText = (cur.trim() ? '\n\n' : '') + clipped;
        $('bgInput').value = cur + blockText;
        state.cfg.background = $('bgInput').value;
        state.files.push({ id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6), name: f.name, chars: clipped.length, text: clipped });
        if (clipped.length < text.length) toast('材料太长，只取了前 ' + clipped.length + ' 字', true);
        else toast('已读入 ' + f.name + '（' + clipped.length + ' 字）');
      } catch (err) {
        toast(f.name + '：' + (err.message || '读取失败'), true);
      }
    }
    renderFileChips();
  }

  function renderFileChips() {
    const box = $('fileChips');
    if (!box) return;
    box.innerHTML = '';
    state.files.forEach((f) => {
      const el = document.createElement('span');
      el.className = 'file-chip';
      el.innerHTML = '<b>' + esc(f.name) + '</b><span class="fc-n">' + f.chars + ' 字</span><button type="button" title="从材料里移除">×</button>';
      el.querySelector('button').onclick = () => {
        const v = $('bgInput').value;
        const idx = v.indexOf(f.text);
        if (idx >= 0) $('bgInput').value = (v.slice(0, idx) + v.slice(idx + f.text.length)).replace(/\n{3,}/g, '\n\n').trim();
        state.cfg.background = $('bgInput').value;
        state.files = state.files.filter((x) => x.id !== f.id);
        renderFileChips();
      };
      box.appendChild(el);
    });
  }

  /* ================= 我的配置 ================= */
  function defaultPresetName() {
    const s = currentScene();
    const r = currentRound();
    return s.label + '·' + r.label + '·' + state.cfg.total + '题' + (state.cfg.mode === 'real' ? '·实战' : '');
  }

  function presetMeta(cfg) {
    const s = SCENES.find((x) => x.key === cfg.scene) || currentScene();
    const r = ROUNDS[cfg.round] || currentRound();
    return [s.label, r.label, (cfg.total || 7) + ' 题', cfg.mode === 'real' ? '实战 ' + (cfg.limit || 90) + ' 秒' : '练习'].join(' · ');
  }

  function renderPresetBar() {
    const bar = $('presetBar');
    if (!bar) return;
    const items = state.presets.map((p) =>
      '<span class="pb-item" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
        '<b>' + esc(p.name) + '</b>' +
        '<button class="pb-load" type="button" data-act="load">载入</button>' +
        '<button type="button" data-act="del" title="删除">×</button>' +
      '</span>').join('');
    bar.innerHTML =
      '<div class="pb-left"><span class="pb-label">我的配置</span>' +
        (state.user
          ? (items || '<span class="pb-empty">还没有保存过配置。选好场景、题量、模式，点右边存下来。</span>')
          : '<span class="pb-empty">登录后可以把这套配置存下来，下次一键载入</span>') +
      '</div>' +
      (state.user
        ? '<div class="pb-right">' +
            '<input id="presetName" maxlength="24" placeholder="' + esc(defaultPresetName()) + '" value="' + esc(state.presetName || '') + '">' +
            '<button class="ghost small" id="btnSavePreset2" type="button">保存当前配置</button>' +
          '</div>'
        : '<button class="ghost small" id="btnPresetLogin" type="button">登录</button>');
  }

  async function loadPresets(force) {
    if (!state.user) { state.presets = []; state.presetsLoaded = false; renderPresetBar(); return; }
    if (state.presetsLoaded && !force) { renderPresetBar(); return; }
    const { data, error } = await cloud.database
      .from('interview_presets')
      .select('id, name, cfg, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      toast('配置读取失败：' + (error.message || '未知错误'), true);
      return;
    }
    state.presets = data || [];
    state.presetsLoaded = true;
    if (state.screen === 'setup') renderPresetBar();
  }

  async function savePreset() {
    if (!state.user) { openAuth(); return; }
    if (state.presets.length >= 20) { toast('最多存 20 套配置，先删几套', true); return; }
    const name = (state.presetName || '').trim() || defaultPresetName();
    const cfg = {
      scene: state.cfg.scene,
      job: state.cfg.job,
      round: state.cfg.round,
      pressure: state.cfg.pressure,
      persona: state.cfg.persona,
      total: state.cfg.total,
      background: (state.cfg.background || '').slice(0, 6000),
      focus: (state.cfg.focus || '').slice(0, 160),
      mode: state.cfg.mode,
      limit: state.cfg.limit,
      brief: state.cfg.brief || {}
    };
    const { error } = await cloud.database.from('interview_presets').insert({ name, cfg }).select();
    if (error) { toast('保存失败：' + (error.message || '未知错误'), true); return; }
    state.presetName = '';
    toast('已保存配置「' + name + '」');
    await loadPresets(true);
  }

  function loadPreset(id) {
    const p = state.presets.find((x) => String(x.id) === String(id));
    if (!p || !p.cfg) return;
    const c = p.cfg;
    const roundKey = ROUNDS[c.round] ? c.round : 'club';
    const r = ROUNDS[roundKey];
    const sceneKey = SCENES.some((s) => s.key === c.scene) ? c.scene : r.scene;
    state.cfg = {
      scene: sceneKey,
      job: c.job || SCENES.find((s) => s.key === sceneKey).subjects[0],
      round: roundKey,
      pressure: PRESSURES[c.pressure] ? c.pressure : 'standard',
      persona: r.personas.indexOf(c.persona) >= 0 ? c.persona : r.personas[0],
      total: (r.counts || [7]).indexOf(Number(c.total)) >= 0 ? Number(c.total) : (r.counts || [7])[0],
      background: c.background || '',
      focus: c.focus || '',
      mode: MODES[c.mode] ? c.mode : 'practice',
      limit: LIMITS.indexOf(Number(c.limit)) >= 0 ? Number(c.limit) : 90,
      brief: {
        times: (c.brief && c.brief.times) || '',
        prep: (c.brief && c.brief.prep) || '',
        mood: (c.brief && c.brief.mood) || '',
        tone: (c.brief && c.brief.tone) || ''
      }
    };
    state.files = [];
    $('bgInput').value = state.cfg.background;
    $('focusInput').value = state.cfg.focus || '';
    renderSetup();
    toast('已载入「' + p.name + '」，直接进面试室就行');
  }

  async function deletePreset(id, name) {
    if (!window.confirm('删除配置「' + (name || '') + '」？')) return;
    const { error } = await cloud.database.from('interview_presets').delete().eq('id', id);
    if (error) { toast('删除失败：' + (error.message || '未知错误'), true); return; }
    await loadPresets(true);
    toast('已删除');
  }

  /* ================= 面试室 ================= */
  function startTimer() {
    stopTimer();
    state.startedAt = Date.now();
    state.timerId = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      $('timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }
  function stopTimer() { if (state.timerId) clearInterval(state.timerId); state.timerId = null; }

  /* 每题倒计时（实战模式） */
  function stopQuestionTimer() {
    if (state.qTimerId) clearInterval(state.qTimerId);
    state.qTimerId = null;
    $('qTimer').classList.remove('urgent');
  }

  function startQuestionTimer(isFollowup) {
    stopQuestionTimer();
    const el = $('qTimer');
    if (state.cfg.mode !== 'real') {
      el.classList.add('hidden');
      state.qStartedAt = Date.now();
      state.qLimit = 0;
      return;
    }
    const base = Number(state.cfg.limit) || 90;
    /* 追问更短：只在已经想过的这件事上补一句，不该再从零组织 */
    const limit = isFollowup ? Math.max(30, Math.round(base * 0.6)) : base;
    state.qLimit = limit;
    state.qStartedAt = Date.now();
    el.classList.remove('hidden');
    const paint = () => {
      const left = Math.max(0, limit - Math.floor((Date.now() - state.qStartedAt) / 1000));
      el.textContent = '剩 ' + left + 's';
      el.classList.toggle('urgent', left <= 10);
      if (left <= 0) {
        stopQuestionTimer();
        timeUp();
      }
    };
    paint();
    state.qTimerId = setInterval(paint, 250);
  }

  function timeUp() {
    if (state.screen !== 'room' || state.streaming) return;
    const hasText = $('answerInput').value.trim().length >= 2;
    toast(hasText ? '时间到，这一题按现在写的内容交' : '时间到，这题按没答算', true);
    submitAnswer(!hasText, true);
  }

  function renderRoomMeta() {
    const c = state.cfg;
    const r = currentRound();
    $('roomMeta').innerHTML =
      '<b>' + esc(c.job) + '</b><span class="pill">' + esc(sceneOfRound(c.round).label) + '</span>' +
      '<span class="pill">' + esc(r.label) + '</span>' +
      (r.lang === 'en' ? '<span class="pill rust">English only</span>' : '') +
      (r.noFollowup ? '<span class="pill">题本 · 不追问</span>' : '') +
      '<span class="pill' + (c.pressure === 'hard' ? ' rust' : '') + '">' + esc(PRESSURES[c.pressure].label) + '</span>' +
      '<span class="pill' + (c.mode === 'real' ? ' rust' : '') + '">' + esc(c.mode === 'real' ? '实战 ' + c.limit + ' 秒/题' : '练习') + '</span>' +
      '<span class="pill">' + esc(c.persona) + '</span>';
    $('sidePressure').textContent = PRESSURES[c.pressure].label;
    $('sidePressureNote').textContent = r.noFollowup
      ? '题本面试：只念题，不追问。'
      : PRESSURES[c.pressure].short;
  }

  function renderProgress() {
    const total = state.cfg.total;
    const cur = Math.min(state.qIndex, total);
    let bars = '';
    for (let i = 1; i <= total; i++) {
      bars += '<i class="' + (i < cur ? 'done' : i === cur ? 'cur' : '') + '"></i>';
    }
    const tail = state.sub && state.fuPlan
      ? ' · 追问 ' + state.sub + '/' + state.fuPlan
      : '';
    $('sideProgress').innerHTML = bars + '<div class="progress-num">第 ' + cur + ' / ' + total + ' 题' + tail + '</div>';
    const sf = ROUNDS[state.cfg.round].sideFocus;
    $('sideFocus').textContent = sf[(cur - 1) % sf.length];
  }

  function addMessage(role, text, opts, container) {
    const box = container || $('chat');
    const layer = (opts && opts.sub) ? Number(opts.sub) : 0;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'interviewer' ? 'q' : role === 'candidate' ? 'a' : 'sys') + (layer ? ' sub' : '');
    if (role !== 'sys') {
      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = esc(role === 'interviewer' ? state.cfg.persona : '你') +
        (layer ? '<span class="fu-tag">追问 ' + layer + '</span>' : '') +
        (opts && opts.via === 'voice' ? '<span class="mtag">语音 ' + mmss(opts.seconds || 0) + '</span>' : '');
      wrap.appendChild(who);
    }
    if (role === 'interviewer') {
      const av = document.createElement('img');
      av.className = 'avatar';
      av.src = mascotFor();
      av.alt = '';
      av.loading = 'lazy';
      wrap.appendChild(av);
    }
    const body = document.createElement('div');
    body.className = 'body' + (opts && opts.skipped ? ' skipped' : '');
    if (role === 'interviewer' && text === '') {
      body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    } else {
      body.textContent = text;
    }
    wrap.appendChild(body);
    box.appendChild(wrap);
    scrollBottom(box);
    return body;
  }

  function scrollBottom(box) {
    const b = box || $('chat');
    requestAnimationFrame(() => { b.scrollTop = b.scrollHeight; });
  }

  function cleanInterviewerText(t) {
    return String(t || '')
      .replace(/^\s*面试官\s*[:：]\s*/i, '')
      .replace(/\*\*/g, '')
      .replace(/^#+\s*/gm, '')
      .trim();
  }

  /* 首页那行字旁边的播放键。
     有本地录音就放录音（放一个 assets/niganma.mp3 进来即可），
     没有就用系统中文语音念一句“你干嘛，哎哟”，至少点了有反应。 */
  let memeAudioState = 0; /* 0 还没试过，1 有录音，2 没有录音 */
  function speakMeme(done) {
    const synth = window.speechSynthesis;
    if (!synth) { done(); toast('这个浏览器不支持播放语音', true); return; }
    const u = new SpeechSynthesisUtterance('你干嘛，哎哟');
    u.lang = 'zh-CN';
    u.rate = 0.78;
    u.pitch = 1.6;
    u.volume = 1;
    const vs = (synth.getVoices() || []).filter((v) => /zh|cmn|Chinese/i.test(v.lang || ''));
    if (vs.length) u.voice = vs[0];
    u.onend = done;
    u.onerror = done;
    try { synth.cancel(); synth.speak(u); } catch (e) { done(); }
  }
  function playMeme() {
    const btn = $('btnMeme');
    if (!btn) return;
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    btn.classList.add('playing');
    const done = () => setTimeout(() => btn.classList.remove('playing'), 300);
    if (memeAudioState === 2) { speakMeme(done); return; }
    if (typeof Audio === 'undefined') { memeAudioState = 2; speakMeme(done); return; }
    let fell = false;
    const fallback = () => { if (fell) return; fell = true; memeAudioState = 2; speakMeme(done); };
    let a;
    try { a = new Audio('assets/niganma.mp3'); } catch (e) { memeAudioState = 2; speakMeme(done); return; }
    a.onended = done;
    a.onerror = fallback;
    const pr = a.play();
    if (pr && pr.then) pr.then(() => { memeAudioState = 1; }).catch(fallback);
  }

  async function startInterview() {
    if (!cloud) { toast('云服务未初始化，请刷新页面', true); return; }
    if (state.cfg.job === '自定义') { toast('先写一个具体岗位', true); return; }
    const r = currentRound();
    voice.stop();
    voice.reset();
    drillVoice.stop();
    drillVoice.reset();
    delete state.cfg.speech;
    $('voiceLang').textContent = r.lang === 'en' ? 'EN' : '中文';
    $('answerInput').placeholder = r.lang === 'en'
      ? 'Answer in English. Ctrl / ⌘ + Enter 发送。'
      : (r.noFollowup ? '按题作答，像真考场那样：先表态，再分层，最后落到做法。' : '像真面试那样回答。Ctrl / ⌘ + Enter 发送。');
    $('drillInput').placeholder = r.lang === 'en' ? 'Answer again in English.' : '重来一次，把上一次没给的证据补上。';
    state.turns = [];
    state.qIndex = 0;
    state.sub = 0;
    state.fuPlan = 0;
    state.fuTotal = 0;
    state.replanned = false;
    state.usedStyles = [];
    state.lastShapes = [];
    state.report = null;
    state.savedId = null;
    state.favSet = {};
    state.plan = [];
    $('chat').innerHTML = '';
    $('answerInput').value = '';
    show('room');
    renderRoomMeta();
    renderProgress();
    stopQuestionTimer();
    $('qTimer').classList.add('hidden');
    state.qStartedAt = 0;
    startTimer();

    /* 有材料时，开场前先按材料排一份题单；这一步决定后面每题是不是真问在材料上 */
    const bgText = (state.cfg.background || '').trim();
    let loading = null;
    if (bgText) {
      loading = addMessage('sys', '正在把材料拆成题…').parentElement;
    }
    state.plan = await preparePlan(state.cfg);
    if (loading && loading.parentElement) loading.parentElement.removeChild(loading);
    await askQuestion();
  }

  function historyMessages() {
    const msgs = [];
    state.turns.forEach((t) => {
      msgs.push({ role: t.role === 'interviewer' ? 'assistant' : 'user', content: t.text });
    });
    return msgs;
  }


  /* ---------------- 出题：开口之前，先把题单排好 ----------------
     有材料 → 让出题人照着材料排一份，每题挂一个材料细节；
     没材料 → 题库排一份，中途再从他自己说过的话里补两道。 */
  const QUSED_KEY = 'ic_qused_v1';
  function readQUsed() {
    try { return JSON.parse(localStorage.getItem(QUSED_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeQUsed(map) {
    try { localStorage.setItem(QUSED_KEY, JSON.stringify(map)); } catch (e) {}
  }

  function dimsCount() { return (currentRound().dims || []).length || 5; }
  function dimIndex(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(dimsCount() - 1, Math.round(n))) : 0;
  }

  /* 社团 / 学生组织 / 保研这些真实流程里，第一题就是自我介绍。
     这一题不该交给模型随机决定，程序直接排进去，顺序和真实面试一致。 */
  function withIntro(cfg, plan) {
    const scr = (typeof screenOfRound === 'function') ? screenOfRound(cfg.round) : null;
    if (!scr || !scr.intro) return plan || [];
    const head = {
      q: scr.intro,
      a: '', d: 0, p: [],
      why: '开场：看他怎么介绍自己，有没有真东西',
      v: '介绍里有没有具体做过的事，还是只有形容词',
      src: 'intro'
    };
    const rest = (plan || []).filter((x) => x && !/自我介绍/.test(String(x.q)));
    return [head].concat(rest).slice(0, cfg.total);
  }

  function bankPlan(cfg) {
    if (typeof pickPlan !== 'function') return [];
    const store = readQUsed();
    const used = store[cfg.round] || [];
    /* 多抓几条，好把“第一次来就别问你对我们的了解”这类题换掉 */
    const raw = pickPlan(cfg.round, cfg.total + 6, used);
    const plan = (raw.filter((x) => !(typeof briefRejects === 'function' && briefRejects(cfg, x.q)))).slice(0, cfg.total);
    /* 换掉的太多、不够题量时，还是把原来的补回来，别让面试中途断掉 */
    if (plan.length < cfg.total) {
      raw.forEach((x) => { if (plan.length < cfg.total && plan.indexOf(x) < 0) plan.push(x); });
    }
    store[cfg.round] = used.concat(plan.map((x) => x.q)).slice(-120);
    writeQUsed(store);
    const defs = dimsOfRound(cfg.round);
    return withIntro(cfg, plan.map((x) => ({
      q: x.q, p: x.p || [], d: x.d, a: '',
      why: (defs[x.d] && defs[x.d].key) ? '考' + defs[x.d].key : '',
      src: 'bank'
    })));
  }

  async function preparePlan(cfg) {
    const bg = (cfg.background || '').trim();
    if (!bg) return bankPlan(cfg);
    state.planGaps = [];
    try {
      const pr = buildMaterialPlanPrompt(cfg, cfg.total);
      const d = await requestJSON(pr.system, pr.user, 0.75);
      const raw = (Array.isArray(d.items) ? d.items : []).filter((x) => x && x.q);
      /* 出题人也会问出“几月几号在哪间教室”“你这门课绩点多少”，进题单前先用程序筛一遍 */
      const items = [];
      raw.forEach((x) => {
        const q = String(x.q).slice(0, 120);
        const bad = (typeof screenValueOf === 'function')
          ? screenValueOf(q, cfg.round)
          : (typeof askValueOf === 'function' ? askValueOf(q) : null);
        if (bad) return;
        if (typeof briefRejects === 'function' && briefRejects(cfg, q)) return;
        items.push({
          q: q,
          a: String(x.a || '').slice(0, 60),
          d: dimIndex(x.d),
          why: String(x.why || '').slice(0, 40),
          v: String(x.v || '').slice(0, 40),
          p: [],
          src: 'mat'
        });
      });
      if (!items.length) return [];
      state.planGaps = (Array.isArray(d.gaps) ? d.gaps : []).slice(0, 3).map((g) => String(g).slice(0, 40));
      let out = items.slice(0, cfg.total);
      /* 材料只够出几题时，用题库补到题量，别让面试中途断掉 */
      if (out.length < cfg.total && typeof pickPlan === 'function') {
        const pad = pickPlan(cfg.round, cfg.total - out.length, []);
        const defs2 = dimsOfRound(cfg.round);
        out = out.concat(pad.map((x) => ({
          q: x.q, a: '', d: x.d, p: x.p || [], src: 'bank',
          why: (defs2[x.d] && defs2[x.d].key) ? '考' + defs2[x.d].key : ''
        })));
      }
      return withIntro(cfg, out.slice(0, cfg.total));
    } catch (e) {
      /* 出题失败就退回“锚点 + 轮次指令”，不让整场面试卡在开场 */
      return [];
    }
  }

  /* 每题锁定一个材料锚点，按顺序轮转 */
  function anchorForTurn(i) {
    if (typeof extractAnchors !== 'function') return 0;
    const anchors = extractAnchors(state.cfg.background || '', 8);
    if (!anchors.length) return 0;
    let base = 0;
    try {
      const order = Object.keys(ROUNDS);
      base = Math.max(0, order.indexOf(String(state.cfg.round || '')));
    } catch (e) { base = 0; }
    return ((i + base) % anchors.length) + 1;
  }

  /* 题单里的材料原句 → 落到第几个锚点，好让纠偏逻辑复用 */
  function anchorIndexFor(quote) {
    if (!quote || typeof extractAnchors !== 'function') return 0;
    const anchors = extractAnchors(state.cfg.background || '', 8, true);
    let best = 0;
    let bestHit = 0;
    anchors.forEach((a, i) => {
      const hit = overlap(a, quote);
      if (hit > bestHit) { bestHit = hit; best = i + 1; }
    });
    return bestHit >= 2 ? best : 0;
  }

  /* 他刚才到底答了什么 —— 后面出题、追问都要用到 */
  function collectClaims() {
    const seen = {};
    const picked = [];
    state.turns.forEach((t) => {
      if (t.role !== 'candidate' || t.skipped) return;
      String(t.text || '').split(/[。；！？\n!?;]/).forEach((raw) => {
        const x = raw.replace(/^[\s·•\-*]+/, '').trim();
        if (x.length < 8 || x.length > 56) return;
        const key = x.slice(0, 10);
        if (seen[key]) return;
        let score = 0;
        if (/\d/.test(x)) score += 2;
        if (/(我|自己|负责|带|做|拿|跑|写|搭|谈|组织|独立)/.test(x)) score += 2;
        if (/(万|千|个|人|次|天|周|月|年|小时|%|％|元|倍|分)/.test(x)) score += 3;
        if (score < 3) return;
        seen[key] = 1;
        picked.push({ s: x, score: score });
      });
    });
    return picked.sort((a, b) => b.score - a.score).slice(0, 6).map((x) => x.s);
  }

  function mainAnswered() {
    const set = {};
    state.turns.forEach((t) => { if (t.role === 'candidate' && t.qIndex && !t.sub) set[t.qIndex] = 1; });
    return Object.keys(set).length;
  }

  /* 第三题之前，用他自己的回答重排后面的题：没材料时，他自己就是材料 */
  async function replanFromAnswers() {
    if (state.replanned) return;
    if ((state.cfg.background || '').trim()) return; /* 有材料时题单已经落在材料上，不再换 */
    /* 社团 / 学生组织按固定流程走，重排会冲掉“了解我们”“策划活动”“部门手艺”这类必问题 */
    const scr = (typeof screenOfRound === 'function') ? screenOfRound(state.cfg.round) : null;
    if (scr && scr.noReplan) return;
    const n = mainAnswered();
    if (state.cfg.total < 5 || n < 2 || n >= state.cfg.total - 1) return;
    if (!state.plan || state.plan.length < state.cfg.total) return;
    state.replanned = true;
    try {
      const pr = buildAnswerPlanPrompt(state.cfg, state.turns, Math.min(3, state.cfg.total - n - 1));
      const d = await requestJSON(pr.system, pr.user, 0.8);
      const items = (Array.isArray(d.items) ? d.items : [])
        .filter((x) => {
          if (!x || !x.q) return false;
          const bad = (typeof screenValueOf === 'function')
            ? screenValueOf(String(x.q), state.cfg.round)
            : (typeof askValueOf === 'function' ? askValueOf(String(x.q)) : null);
          return !bad;
        })
        .map((x) => ({
          q: String(x.q).slice(0, 120),
          a: String(x.a || '').slice(0, 60),
          d: dimIndex(x.d),
          why: String(x.why || '').slice(0, 40),
          v: String(x.v || '').slice(0, 40),
          p: [],
          src: 'ans'
        }));
      if (!items.length) return;
      const keep = state.plan.slice(0, n);
      const tail = state.plan.slice(n + items.length);
      state.plan = keep.concat(items, tail).slice(0, state.cfg.total);
    } catch (e) { /* 补题失败就用原来的题单 */ }
  }

  /* 面试官原地打转的兜底：新问题与前面几题的字面重合过高，就重出一句 */
  function qPairs(str) {
    const clean = String(str || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const out = [];
    for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
    return out;
  }
  function qSimilar(a, b) {
    const A = qPairs(a);
    const B = qPairs(b);
    if (!A.length || !B.length) return 0;
    const setA = {};
    const setB = {};
    A.forEach((x) => { setA[x] = 1; });
    B.forEach((x) => { setB[x] = 1; });
    let hit = 0;
    Object.keys(setA).forEach((x) => { if (setB[x]) hit += 1; });
    const na = Object.keys(setA).length;
    const nb = Object.keys(setB).length;
    return hit / (na + nb - hit);
  }
  function repeatsEarlier(text, earlier) {
    const sims = earlier.slice(-4).map((q) => qSimilar(text, q)).sort((a, b) => b - a);
    if (!sims.length) return 0;
    if (sims[0] >= 0.62) return sims[0];
    if (sims.length > 1 && sims[0] >= 0.42 && sims[1] >= 0.42) return sims[0];
    return 0;
  }

  /* 问法机械检测：连着两题都用同一种模板（问谁测的 / 问分工 / 求举例），就是机械。
     这不是重复问同一件事，是同一个句式被反复用——听的人会觉得像在填表。 */
  function shapeRepeat(text) {
    if (typeof templateAsk !== 'function') return '';
    const tag = templateAsk(text);
    if (!tag) return '';
    return (state.lastShapes || []).slice(-2).indexOf(tag) >= 0 ? tag : '';
  }
  function noteShape(text) {
    const tag = (typeof templateAsk === 'function') ? templateAsk(text) : '';
    state.lastShapes = (state.lastShapes || []).concat(tag).slice(-8);
  }

  /* 判断这一句有没有真的用上分配给它的材料锚点 */
  const ANCHOR_STOP = {};
  ('你的 这个 那个 什么 怎么 一个 我们 他们 如果 你是 有没 没有 问的 是不 那这 这边 说清 清楚 具体 有没有 是不是 多少').split(' ').forEach((w) => { ANCHOR_STOP[w] = 1; });

  function grams(str) {
    const c = String(str || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const out = {};
    for (let i = 0; i < c.length - 1; i++) {
      const t = c.slice(i, i + 2);
      if (!ANCHOR_STOP[t]) out[t] = 1;
    }
    return out;
  }
  /* 两段话共享多少组二字词：用来判断“这句是不是在说那件事”，不看字面长度 */
  function overlap(base, probe) {
    const A = grams(base);
    let hit = 0;
    Object.keys(grams(probe)).forEach((t) => { if (A[t]) hit += 1; });
    return hit;
  }

  function anchorMissed(text, anchorNo) {
    if (!anchorNo) return false;
    if (typeof extractAnchors !== 'function') return false;
    const anchors = extractAnchors(state.cfg.background || '', 8, true);
    const a = anchors[anchorNo - 1];
    if (!a) return false;
    return overlap(a, text) < 2;
  }

  /* 这一句到底有没有在问题单里那道题（防止模型顺着上一题越跑越远） */
  function planMissed(text, item) {
    if (!item || !item.q) return false;
    return overlap(item.q, text) < 2;
  }

  /* 题单里指定的材料细节有没有被问出来：数字对得上就算，否则看字面重合 */
  function detailMissed(text, quote) {
    if (!quote) return false;
    const nums = String(quote).match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length && nums.some((n) => String(text).indexOf(n) >= 0)) return false;
    return overlap(quote, text) < 2;
  }

  /* 追问必须踩着他刚说的那句，不能自说自话 */
  function fuOffTopic(text, answer) {
    if (!answer) return false;
    const nums = (String(text).match(/\d+(?:\.\d+)?/g) || []).filter((n) => String(answer).indexOf(n) >= 0).length;
    return overlap(answer, text) + nums === 0;
  }

  async function askQuestion() {
    if (state.qIndex >= state.cfg.total) { finishInterview(); return; }
    state.qIndex += 1;
    state.sub = 0;
    state.fuPlan = 0;
    renderProgress();
    setComposerEnabled(false);
    const body = addMessage('interviewer', '');
    const asked = state.turns.filter((t) => t.role === 'interviewer').map((t) => t.text);
    const planItem = state.plan[state.qIndex - 1] || null;
    const anchorNo = (planItem && planItem.a) ? anchorIndexFor(planItem.a) : anchorForTurn(state.qIndex - 1);
    /* 这一题用哪一种问法：同一个角度换条路走，别每次都“这个数谁测的” */
    const styleInfo = (typeof styleFor === 'function')
      ? styleFor(state.cfg.round, state.qIndex - 1, 1, state.usedStyles)
      : { key: '', text: '' };
    const sys = buildInterviewerSystem(state.cfg, state.qIndex - 1, state.cfg.total, {
      asked: asked,
      anchor: anchorNo,
      claims: collectClaims(),
      plan: state.plan,
      styleHint: styleInfo.text,
      mood: (typeof moodLine === 'function') ? moodLine(state.patience) : ''
    });
    let msgs = [{ role: 'system', content: sys }];
    if (state.turns.length === 0) {
      msgs.push({ role: 'user', content: openingUserMessage(state.cfg) });
    } else {
      msgs = msgs.concat(historyMessages());
    }
    let first = true;
    try {
      const text = await streamChat({
        messages: msgs,
        temperature: state.cfg.pressure === 'hard' ? 1.05 : 0.95,
        onDelta: (d, full) => {
          if (first) { body.textContent = ''; first = false; }
          body.textContent = cleanInterviewerText(full);
          scrollBottom();
        }
      });
      let finalText = cleanInterviewerText(text);
      const prevQs = state.turns.filter((t) => t.role === 'interviewer').map((t) => t.text);
      const missAnchor = (planItem && planItem.a) ? detailMissed(finalText, planItem.a) : anchorMissed(finalText, anchorNo);
      const missPlan = planItem ? planMissed(finalText, planItem.q) : false;
      const lowAsk = (typeof screenValueOf === 'function')
        ? screenValueOf(finalText, state.cfg.round)
        : ((typeof askValueOf === 'function') ? askValueOf(finalText) : null);
      const shape = shapeRepeat(finalText);
      const regMain = (typeof offRegister === 'function') ? offRegister(finalText, state.cfg.round) : null;
      const aiMain = (typeof aiVoice === 'function') ? aiVoice(finalText, state.cfg.round) : null;
      if (finalText && (lowAsk || regMain || aiMain || shape || missAnchor || missPlan || repeatsEarlier(finalText, prevQs))) {
        /* 问了不值得问的 / 用错了词 / 又是同一种模板 / 没扣住材料细节 / 没问本题该问的事 / 和前面太像，重出一句；只重试一次，失败就用原来的 */
        body.textContent = '';
        const why = lowAsk
          ? '你刚才那句问的是' + lowAsk.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + lowAsk.fix + ' 换成能看出他判断、取舍或数字出处的一问。'
          : (aiMain
            ? '你刚才那句不像人说的话：' + aiMain.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + aiMain.fix
            : (regMain
            ? '你刚才那句' + regMain.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + regMain.fix
            : (shape
            ? '你刚才那句又用回了同一种问法（原文：「' + finalText.slice(0, 36) + '」）。这一场已经问过两次这种模板了，听上去像在填表。换一条路：同一个意思可以问两端、问分母、问相反的情况、问改动之前，或者把话说的人拆开问。'
            : (missAnchor
                ? ((planItem && planItem.a)
                    ? '你刚才那句没带上本题的材料细节（原句：「' + finalText.slice(0, 36) + '」）。本题必须落在这一句上：「' + planItem.a + '」——把其中的人、数字或做法放进问题里，不要问成时间、态度这类通用题。'
                    : '你刚才那句没用上本题的锚点，问成了材料之外的事（原句：「' + finalText.slice(0, 36) + '」）。现在只问锚点 ' + anchorNo + ' 里写的那件事：把其中的人、数字或做法放进问题里，不要问成时间、态度这类通用题。')
                : (missPlan
                    ? '你刚才那句没问本题该问的事，跑去追上一题了（原句：「' + finalText.slice(0, 36) + '」）。本题只问这一件：「' + planItem.q + '」。不要接话、不要追上一题，把这件事直接问出来。'
                    : '你刚才那句和前面某题几乎重复（原句：「' + finalText.slice(0, 36) + '」）。换一个细节或换一个侧面，只问一件新的事。')))));
        const sysFix = sys + '\n\n【纠偏】' + why + ' 不要解释、不要提重复、不要道歉，直接给新问题。';
        try {
          const again = await streamChat({
            messages: [{ role: 'system', content: sysFix }].concat(msgs.slice(1)),
            temperature: state.cfg.pressure === 'hard' ? 1.05 : 0.95,
            onDelta: (d, full) => {
              body.textContent = cleanInterviewerText(full);
              scrollBottom();
            }
          });
          const alt = cleanInterviewerText(again);
          const altDetailOk = (planItem && planItem.a) ? !detailMissed(alt, planItem.a) : !anchorMissed(alt, anchorNo);
          const altPlanOk = !planItem || !planMissed(alt, planItem.q);
          const altValueOk = (typeof screenValueOf === 'function')
            ? !screenValueOf(alt, state.cfg.round)
            : !(typeof askValueOf === 'function' && askValueOf(alt));
          const altShapeOk = !shapeRepeat(alt);
          const altRegOk = !(typeof offRegister === 'function' && offRegister(alt, state.cfg.round));
          if (alt && altValueOk && altShapeOk && altRegOk && !repeatsEarlier(alt, prevQs) && altDetailOk && altPlanOk) finalText = alt;
          else if (alt && altValueOk && altRegOk && altPlanOk) finalText = alt;
        } catch (e2) { /* 重出失败就沿用原句 */ }
      }
      finalText = finalText || '（这题先跳过，我们换一个方向。）';
      body.textContent = finalText;
      noteShape(finalText);
      if (styleInfo && styleInfo.key) state.usedStyles.push(styleInfo.key);
      state.turns.push({ role: 'interviewer', text: finalText, qIndex: state.qIndex, sub: 0 });
      setComposerEnabled(true);
      $('answerInput').focus();
      startQuestionTimer();
    } catch (err) {
      const wrap = body.parentElement;
      body.innerHTML = '<span style="color:#a83a2c">' + esc(llmErrorMessage(err)) + '</span>';
      const retry = document.createElement('button');
      retry.className = 'ghost small';
      retry.style.marginTop = '10px';
      retry.textContent = '重试这一题';
      retry.onclick = () => {
        if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
        state.qIndex -= 1;
        askQuestion();
      };
      body.appendChild(document.createElement('br'));
      body.appendChild(retry);
      setComposerEnabled(false);
      stopQuestionTimer();
    }
  }

  /* ---------------- 追问：就着他刚说的那句往下挖 ---------------- */
  /* 这一道题追几层：压力档定上限，答案里洞越多越往上顶 */
  const FU_TABLE = {
    mild: [0, 1, 1, 1],      /* 洞 0 / 1 / 2 / 3+ */
    standard: [1, 1, 2, 2],
    hard: [2, 2, 3, 3]
  };
  function fuBudgetFor(text, skipped) {
    const r = currentRound();
    if (r.noFollowup || skipped) return 0;
    const p = PRESSURES[state.cfg.pressure] || PRESSURES.standard;
    let max = p.fu || 2;
    if (state.cfg.mode === 'real') max = Math.max(1, max - 1); /* 限时实战，少挖一层 */
    /* 整场总量兜底，别把一场面试拖成四十轮 */
    const cap = Math.ceil(state.cfg.total * (state.cfg.pressure === 'hard' ? 1.8 : 1.2));
    const room = cap - state.fuTotal;
    if (room <= 0) return 0;
    const row = FU_TABLE[state.cfg.pressure] || FU_TABLE.standard;
    const n = Math.min(3, detectGaps(text, r.lang === 'en' ? 'en' : 'zh').length);
    return Math.max(0, Math.min(row[n], max, room));
  }

  async function askFollowup() {
    state.sub += 1;
    state.fuTotal += 1;
    renderProgress();
    setComposerEnabled(false);
    const body = addMessage('interviewer', '', { sub: state.sub });
    const qTurns = state.turns.filter((t) => t.qIndex === state.qIndex);
    const mainQ = (qTurns.find((t) => t.role === 'interviewer' && !t.sub) || {}).text || '';
    const last = qTurns.filter((t) => t.role === 'candidate').slice(-1)[0];
    const answer = last ? last.text : '';
    const gaps = last && !last.skipped ? detectGaps(answer, currentRound().lang === 'en' ? 'en' : 'zh') : [];
    /* 这句话是什么味道：自大、敷衍、紧张、自贬、絮叨、背稿、还是答得扎实。
       味道变了，追问的角度和语气都得跟着变，不然就是拿一份稿子对所有人念。 */
    const manner = (last && !last.skipped && typeof readManner === 'function') ? readManner(answer) : [];
    const qCands = qTurns.filter((t) => t.role === 'candidate');
    const sameBefore = manner.length
      ? qCands.slice(0, -1).filter((t) => (typeof readManner === 'function' ? readManner(t.text) : []).some((m) => manner.some((x) => x.tag === m.tag))).length
      : 0;
    const prevFu = qTurns.filter((t) => t.role === 'interviewer' && t.sub).map((t) => t.text);
    const planItem = state.plan[state.qIndex - 1] || null;
    /* 先定这一层挖哪个角度，再只在这个角度自己的打法里挑——不这么做就会出现
       “角度是要一件具体的事、打法却在问平均值”的错配。 */
    let angleIdx = (typeof angleIndexOf === 'function') ? angleIndexOf(gaps, state.sub, answer) : 0;
    /* 他要是甩态度、躲问题、或者紧张到说不圆，这一层就该往“说一件事”上落，而不是继续按内容挖 */
    const softTag = manner.some((m) => ['arrogant', 'dismissive', 'defiant', 'flattery', 'nervous', 'overhumble', 'joking', 'scripted', 'rambling'].indexOf(m.tag) >= 0);
    if (softTag) angleIdx = (state.sub >= 2 && manner.some((m) => ['arrogant', 'dismissive', 'defiant'].indexOf(m.tag) >= 0)) ? 8 : 7;
    const styleInfo = (typeof styleFor === 'function')
      ? styleFor(state.cfg.round, state.qIndex - 1, state.sub, state.usedStyles, angleIdx)
      : { key: '', text: '' };
    const ctx = {
      sub: state.sub,
      maxSub: state.fuPlan,
      question: mainQ,
      answer: answer,
      gaps: gaps,
      asked: prevFu,
      attitude: manner,
      sameBefore: sameBefore,
      cold: (state.patience || 0) >= 2,
      angle: (typeof FU_ANGLES !== 'undefined' && FU_ANGLES[angleIdx]) || angleForGap(gaps, state.sub),
      style: styleInfo.text,
      anchor: (planItem && planItem.a) ? planItem.a : ''
    };
    const sys = buildFollowupSystem(state.cfg, ctx);
    const temp = state.cfg.pressure === 'hard' ? 1.0 : 0.85;
    try {
      const text = await streamChat({
        messages: [{ role: 'system', content: sys }].concat(historyMessages()),
        temperature: temp,
        onDelta: (d, full) => {
          body.textContent = cleanInterviewerText(full);
          scrollBottom();
        }
      });
      let finalText = cleanInterviewerText(text);
      const lowAsk = (typeof screenValueOf === 'function')
        ? screenValueOf(finalText, state.cfg.round)
        : ((typeof askValueOf === 'function') ? askValueOf(finalText) : null);
      const shape = shapeRepeat(finalText);
      const mech = (typeof mechanicalAsk === 'function' && answer) ? mechanicalAsk(finalText, answer) : null;
      const reg = (typeof offRegister === 'function') ? offRegister(finalText, state.cfg.round) : null;
      const mis = (typeof offManner === 'function') ? offManner(finalText, manner) : null;
      const aiv = (typeof aiVoice === 'function') ? aiVoice(finalText, state.cfg.round) : null;
      const jok = (typeof offJoke === 'function') ? offJoke(finalText, manner) : null;
      /* 走题、或者问的是“问了也不改变判断”的东西：这一问对选拔没用，重说 */
      const pfit = (typeof offPurpose === 'function')
        ? offPurpose(finalText, state.cfg.round, { question: mainQ, answer: answer })
        : null;
      if (finalText && (lowAsk || pfit || shape || mech || reg || mis || aiv || jok || (answer && fuOffTopic(finalText, answer)))) {
        /* 问了不值得问的 / 用错了词 / 接不住对方的脸色 / 在训话 / 又用回同一种模板 / 一句话并排问了几件事 / 没踩着他那句话，重问一次；只重试一次 */
        body.textContent = '';
        const why = lowAsk
          ? '你刚才那层追问问的是' + lowAsk.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + lowAsk.fix + ' 这一层要挖的是他的判断、取舍或数字出处，不是让他补一份记录。'
          : (pfit
            ? '你刚才那层追问' + pfit.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + pfit.fix
            : (jok
            ? '你刚才那层追问' + jok.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + jok.fix
            : (aiv
            ? '你刚才那层追问不像人说的话：' + aiv.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + aiv.fix
            : (mis
            ? '你刚才那层追问接不住他的态度：' + mis.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + mis.fix
            : (reg
              ? '你刚才那层追问' + reg.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + reg.fix
              : (mech
                ? '你刚才那层追问问得没水平：' + mech.label + '（原文：「' + finalText.slice(0, 36) + '」）。' + mech.fix
                : (shape
                  ? '你刚才那层追问又用回了同一种问法（原文：「' + finalText.slice(0, 36) + '」）。换成另一种打法：问最好最差差多少、问没做之前是多少、问相反的情况，或者把话说的人拆开问。不要再用“谁测的”“怎么分工”这一套。'
                  : '你刚才那句没有引用他的原话，问成了另一个话题（原句：「' + finalText.slice(0, 36) + '」）。现在只针对他这句：「' + String(answer).slice(0, 60) + '」——把里面的原词或数字带进问题里，只问一件事。')))))));
        try {
          const again = await streamChat({
            messages: [{ role: 'system', content: sys + '\n\n【纠偏】' + why }].concat(historyMessages()),
            temperature: temp,
            onDelta: (d, full) => {
              body.textContent = cleanInterviewerText(full);
              scrollBottom();
            }
          });
          const alt = cleanInterviewerText(again);
          const altValueOk = (typeof screenValueOf === 'function')
            ? !screenValueOf(alt, state.cfg.round)
            : !(typeof askValueOf === 'function' && askValueOf(alt));
          const altShapeOk = !shapeRepeat(alt);
          const altMechOk = !(typeof mechanicalAsk === 'function' && answer && mechanicalAsk(alt, answer));
          const altRegOk = !(typeof offRegister === 'function' && offRegister(alt, state.cfg.round));
          const altMisOk = !(typeof offManner === 'function' && offManner(alt, manner));
          const altAiOk = !(typeof aiVoice === 'function' && aiVoice(alt, state.cfg.round));
          const altJokeOk = !(typeof offJoke === 'function' && offJoke(alt, manner));
          const altFitOk = !(typeof offPurpose === 'function' && offPurpose(alt, state.cfg.round, { question: mainQ, answer: answer }));
          if (alt && altValueOk && altShapeOk && altMechOk && altRegOk && altMisOk && altAiOk && altJokeOk && altFitOk && !fuOffTopic(alt, answer)) finalText = alt;
          else if (alt && altValueOk && altMechOk && altRegOk && altMisOk && altAiOk && altJokeOk && altFitOk) finalText = alt;
        } catch (e2) {}
      }
      finalText = finalText || '行，那这件事里最难的是哪一段？';
      /* 重出一句还是“审报表”、用错词、在训话、还是接不住他的脸色，就别把不像人说的话摆到人面前 */
      const stillMech = !!(answer && typeof mechanicalAsk === 'function' && mechanicalAsk(finalText, answer));
      const stillReg = !!(typeof offRegister === 'function' && offRegister(finalText, state.cfg.round));
      const stillAi = !!(typeof aiVoice === 'function' && aiVoice(finalText, state.cfg.round));
      const stillMis = !!(typeof offManner === 'function' && offManner(finalText, manner));
      const stillJoke = !!(typeof offJoke === 'function' && offJoke(finalText, manner));
      const stillFit = !!(typeof offPurpose === 'function' && offPurpose(finalText, state.cfg.round, { question: mainQ, answer: answer }));
      if (stillMech || stillReg || stillAi || stillMis || stillJoke || stillFit) {
        const tags = (manner || []).map((m) => m.tag);
        const arro = tags.some((m) => m === 'arrogant' || m === 'dismissive' || m === 'defiant');
        if (tags.indexOf('joking') >= 0) {
          finalText = state.sub >= 2
            ? '行，玩笑到这儿。说件真的：最近哪件事是你自己做成的？'
            : '行，那先当个笑话听。你现在离它最近的一步，是什么？';
        } else if (arro) {
          finalText = state.sub >= 2
            ? '行，我大概知道了。那说个最基础的：这学期你花时间最多的一件事是什么？'
            : '行。那最近一次，你干了什么？';
        } else if (stillFit) {
          finalText = state.sub >= 2
            ? '那这件事里，哪一段是你自己定的？'
            : '这事里最费劲的是哪一步，你当时怎么处理的？';
        } else if (stillReg || stillAi) {
          finalText = '你刚说的这个，最不好办的是哪一段？';
        } else {
          finalText = angleIdx === 7
            ? '最近一次，你为这事做了什么？'
            : '你刚说的这个，最不好办的是哪一段？';
        }
      }
      body.textContent = finalText;
      noteShape(finalText);
      if (styleInfo && styleInfo.key) state.usedStyles.push(styleInfo.key);
      state.turns.push({ role: 'interviewer', text: finalText, qIndex: state.qIndex, sub: state.sub });
      setComposerEnabled(true);
      $('answerInput').focus();
      startQuestionTimer(true);
    } catch (err) {
      /* 追问没生成出来也不能把这层吞掉：给一句兜底追问，保证对话层级不乱 */
      const fallback = '这句先放一放——你刚才说的那件事，具体哪一段是你亲手做的？';
      body.innerHTML = '<span style="color:#a83a2c">' + esc(llmErrorMessage(err)) + '</span>' +
        '<div class="fu-fallback">' + esc(fallback) + '</div>';
      state.turns.push({ role: 'interviewer', text: fallback, qIndex: state.qIndex, sub: state.sub });
      setComposerEnabled(true);
      $('answerInput').focus();
      startQuestionTimer(true);
    }
  }

  function setComposerEnabled(on) {
    state.streaming = !on;
    $('btnSend').disabled = !on;
    $('btnSkip').disabled = !on;
    $('answerInput').disabled = !on;
    $('composerHint').textContent = on
      ? (VOICE_OK && currentRound().lang === 'en'
          ? '点“说”用英语答，转写出来可以再改；别切回中文'
          : (VOICE_OK ? '可以打字，也可以点“说”直接讲'
            : (uaInfo().mobile ? '这个浏览器没有语音接口：点输入法键盘上的话筒键，也能练口语' : '它在听你怎么说，也在听你没说什么')))
      : '它在组织下一句追问…';
  }

  async function submitAnswer(forceSkip, auto) {
    if (state.streaming) return;
    if (voice.listening || voice.wantListening) voice.stop();
    const input = $('answerInput');
    const text = input.value.trim();
    if (!forceSkip && text.length < 2) { toast('写点东西再发，哪怕只有一句', true); return; }
    const spent = state.qStartedAt ? Math.max(1, Math.round((Date.now() - state.qStartedAt) / 1000)) : 0;
    stopQuestionTimer();
    const limit = state.qLimit || Number(state.cfg.limit) || 90;
    const meta = !forceSkip && voice.used() ? { via: 'voice', seconds: voice.seconds, words: voice.words, conf: voice.conf() } : null;
    const skippedText = auto ? '（时间到，没有作答）' : '（跳过这一题，没有回答）';
    addMessage('candidate', forceSkip ? skippedText : text, {
      skipped: forceSkip,
      sub: state.sub,
      via: meta ? 'voice' : '',
      seconds: meta ? meta.seconds : 0
    });
    const turn = {
      role: 'candidate',
      text: forceSkip ? skippedText : text,
      skipped: !!forceSkip,
      spent: spent,
      qIndex: state.qIndex,
      sub: state.sub
    };
    if (auto || (state.cfg.mode === 'real' && spent > limit)) turn.over = true;
    if (meta) Object.assign(turn, meta);
    state.turns.push(turn);
    voice.reset();
    input.value = '';

    /* 他刚刚这句话给人的感觉，会带进下一句：不是每答一次就重新认识一个人。
       自大、敷衍、顶撞、捧人会把耐心磨掉；答得扎实反而会把耐心补回来。 */
    const manner = (typeof readManner === 'function' && !forceSkip) ? readManner(turn.text) : [];
    const wear = manner.reduce((n, m) => n + ((typeof NEG_MANNER !== 'undefined' && NEG_MANNER[m.tag]) || 0), 0);
    state.patience = wear > 0
      ? Math.min(3, (state.patience || 0) + 1)
      : Math.max(0, (state.patience || 0) - 1);

    /* 这一答值不值得再追一层：看压力档，也看答得空不空 */
    if (!state.sub) state.fuPlan = fuBudgetFor(turn.text, forceSkip);
    const left = forceSkip ? 0 : Math.max(0, state.fuPlan - state.sub);
    if (left > 0) { await askFollowup(); return; }

    if (mainAnswered() >= state.cfg.total) { finishInterview(); return; }
    /* 没材料时，用他刚说的这些重排后面几道题 */
    await replanFromAnswers();
    await askQuestion();
  }

  /* ================= 评分与复盘 ================= */
  const SCORING_STEPS = ['拆解你的回答…', '核对数字与归因…', '对照 rubric 打分…', '定位最薄弱的环节…'];
  let stepTimer = null;

  function showScoring(on) {
    $('scoring').classList.toggle('hidden', !on);
    if (on) {
      let i = 0;
      $('scoringStep').textContent = SCORING_STEPS[0];
      clearInterval(stepTimer);
      stepTimer = setInterval(() => {
        i = (i + 1) % SCORING_STEPS.length;
        $('scoringStep').textContent = SCORING_STEPS[i];
      }, 1800);
    } else {
      clearInterval(stepTimer);
    }
  }

  async function finishInterview() {
    if (state.screen !== 'room') return;
    if (mainAnswered() < 1) { toast('至少回答一题再评分', true); return; }
    if (state.streaming && state.abort) { try { state.abort.abort(); } catch (e) {} }
    if (voice.listening || voice.wantListening) voice.stop();
    stopTimer();
    stopQuestionTimer();
    $('qTimer').classList.add('hidden');
    buildSpeechStats();
    showScoring(true);
    const durationSec = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
    try {
      const raw = await requestJSON(
        '你是资深面试评估专家。严格按 rubric 打分，只输出 JSON 对象，不输出任何其他文字、不使用代码块。所有文字用中文。',
        buildScoringPrompt(state.cfg, state.turns),
        0.55
      );
      state.report = normalizeReport(raw);
      state.report.speech = state.cfg.speech || null;
      state.report.durationSec = durationSec;
      state.report.createdAt = new Date();
      state.report.turns = state.turns.slice();
      showScoring(false);
      renderReport();
      show('report');
      saveReportSilently();
    } catch (err) {
      showScoring(false);
      toast(llmErrorMessage(err), true);
      show('room');
      setComposerEnabled(true);
      $('btnFinish').disabled = false;
    }
  }

  function buildSpeechStats() {
    const mains = state.turns.filter((t) => t.role === 'candidate' && !t.sub);
    const voiceTurns = state.turns.filter((t) => t.role === 'candidate' && !t.skipped && t.via === 'voice' && t.seconds >= 3 && t.words > 0);
    if (!voiceTurns.length) { delete state.cfg.speech; return; }
    const spokenMain = mains.filter((t) => !t.skipped && t.via === 'voice' && t.seconds >= 3 && t.words > 0);
    const sec = voiceTurns.reduce((n, t) => n + (t.seconds || 0), 0);
    const words = voiceTurns.reduce((n, t) => n + (t.words || 0), 0);
    /* 语速和识别置信度用全部开口的作答算（含追问），样本大一点才稳 */
    const withConf = voiceTurns.filter((t) => Number(t.conf) > 0);
    const conf = withConf.length
      ? withConf.reduce((n, t) => n + Number(t.conf), 0) / withConf.length
      : 0;
    state.cfg.speech = {
      spoken: spokenMain.length,
      total: mains.length,
      rate: sec >= 15 ? Math.round(words / (sec / 60)) : 0,
      conf: conf ? Math.round(conf * 100) / 100 : 0
    };
  }

  /* 把平坦的对话整理成“每题 + 它的追问层” */
  function groupByQuestion(turns) {
    const byQ = [];
    (turns || []).forEach((t) => {
      if (!t.qIndex) return;
      const k = t.qIndex - 1;
      if (!byQ[k]) byQ[k] = { q: '', a: null, fus: [] };
      if (t.role === 'interviewer') {
        if (!t.sub) byQ[k].q = t.text;
        else byQ[k].fus.push({ q: t.text, a: '', verdict: '' });
      } else if (!t.sub) {
        byQ[k].a = t;
      } else if (byQ[k].fus.length) {
        byQ[k].fus[byQ[k].fus.length - 1].a = t.text;
      }
    });
    return byQ;
  }

  function normalizeReport(d) {
    const defs = dimsOfRound(state.cfg.round);
    const gotDims = Array.isArray(d.dimensions) ? d.dimensions : [];
    const dims = defs.map((rd, i) => {
      const hit = gotDims.find((x) => x && x.key === rd.key) || gotDims[i] || {};
      const score = dimScore(hit.score);
      return {
        key: rd.key,
        short: rd.short,
        score: score,
        comment: hit.comment || (score === null ? '本轮未涉及' : ''),
        evidence: hit.evidence || ''
      };
    });

    const gotQs = Array.isArray(d.questions) ? d.questions : [];
    const byQ = groupByQuestion(state.turns);
    const qs = gotQs.map((q, i) => {
      const slot = byQ[i] || { a: null, fus: [] };
      const ct = slot.a;
      const gotFu = Array.isArray(q.fu) ? q.fu : [];
      /* 追问以程序记录为准（问了什么、怎么答的），评分只补“这一层暴露了什么” */
      const fus = slot.fus.map((f, j) => ({
        q: f.q,
        a: f.a,
        verdict: (gotFu[j] && gotFu[j].verdict) || ''
      }));
      return {
        index: i + 1,
        question: q.question || slot.q || '',
        why: (state.plan[i] && state.plan[i].why) || '',
        goal: (state.plan[i] && state.plan[i].v) || '',
        digest: q.digest || '',
        diagnosis: q.diagnosis || '',
        rewrite: q.rewrite || '',
        model: q.model_answer || q.model || '',
        score: clampScore(q.score),
        spoken: !!(ct && ct.via === 'voice'),
        seconds: ct ? (ct.seconds || 0) : 0,
        words: ct ? (ct.words || 0) : 0,
        spent: (ct && ct.spent) || 0,
        over: !!(ct && ct.over),
        fus: fus
      };
    });

    const scored = dims.filter((x) => x.score !== null);
    const avg = scored.length ? scored.reduce((s, x) => s + x.score, 0) / scored.length : 0;
    const total = Math.round(avg * 20);
    let weakest = d.weakest && typeof d.weakest.index === 'number' ? d.weakest : null;
    let widx = weakest ? weakest.index : 0;
    if (!widx || !qs[widx - 1]) {
      let lowest = qs[0];
      qs.forEach((q) => { if (q.score < (lowest ? lowest.score : 9)) lowest = q; });
      widx = lowest ? lowest.index : 1;
    }
    const wq = qs[widx - 1] || { question: '', score: 2 };

    let language = null;
    if (d.language && typeof d.language === 'object') {
      const fixes = (Array.isArray(d.language.fixes) ? d.language.fixes : [])
        .filter((x) => x && (x.said || x.better))
        .slice(0, 8)
        .map((x) => ({ said: String(x.said || ''), better: String(x.better || ''), why: String(x.why || '') }));
      language = { note: String(d.language.note || ''), oral: String(d.language.oral || ''), fixes: fixes };
    }

    return {
      verdict: d.verdict || '这轮回答信息量偏少，先把一件事讲透。',
      dims: dims,
      total: total,
      questions: qs,
      weakest: {
        index: widx,
        question: wq.question,
        why: (weakest && weakest.why) || wq.diagnosis || '回答里缺少可验证的证据。',
        reprobe: (weakest && weakest.reprobe) || '你刚才说的这个，具体是怎么测出来的？'
      },
      focus: Array.isArray(d.focus) && d.focus.length ? d.focus.slice(0, 3) : ['先把一件事讲透', '所有数字都要能溯源', '把“我们”换成“我”'],
      drills: Array.isArray(d.drills) ? d.drills.slice(0, 3) : [],
      language: language,
      fuTotal: state.turns.filter((t) => t.role === 'interviewer' && t.sub).length
    };
  }

  function gradeOf(total) {
    if (total >= 80) return { label: '有竞争力', color: '#1e3a4f' };
    if (total >= 65) return { label: '可用，需打磨', color: '#7c6b40' };
    if (total >= 50) return { label: '待练', color: '#8a7a4e' };
    return { label: '不合格', color: '#a83a2c' };
  }

  function ringSvg(total, color) {
    const R = 64, C = 2 * Math.PI * R;
    const off = C * (1 - Math.min(100, Math.max(0, total)) / 100);
    return '<svg width="150" height="150" viewBox="0 0 150 150">' +
      '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="#ebe6dc" stroke-width="9"/>' +
      '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>';
  }

  function renderReport() {
    const rep = state.report;
    const c = state.cfg;
    const g = gradeOf(rep.total);
    const dur = Math.round((rep.durationSec || 0) / 60) + ' 分钟';
    const date = (rep.createdAt || new Date()).toLocaleDateString('zh-CN');

    $('reportHero').innerHTML =
      '<div class="report-hero">' +
        '<div class="score-ring">' + ringSvg(rep.total, g.color) +
          '<div class="val"><b>' + rep.total + '</b><span>/ 100</span></div></div>' +
        '<div>' +
          '<div class="rh-who"><img src="' + mascotFor() + '" alt="">' +
            '<span>' + esc(c.persona) + ' · 本场结束后给的判定</span></div>' +
          '<div class="verdict-tag">' + esc(g.label) + '</div>' +
          '<h2>' + esc(rep.verdict) + '</h2>' +
          '<div class="meta-line"><span>' + esc(c.job) + '</span><i></i><span>' + esc(sceneOfRound(c.round).label) + ' / ' + esc(currentRound().label) +
          '</span><i></i><span>' + esc(PRESSURES[c.pressure].label) + '</span>' +
          '<i></i><span>' + esc(c.mode === 'real' ? '实战 ' + c.limit + ' 秒/题' : '练习模式') + '</span>' +
          '<i></i><span>' + esc(date) +
          '</span><i></i><span>' + dur + '</span>' +
          (rep.speech && rep.speech.spoken ? '<i></i><span class="meta-voice">语音 ' + rep.speech.spoken + '/' + rep.speech.total + '</span>' : '') +
          (rep.fuTotal ? '<i></i><span>被追问 ' + rep.fuTotal + ' 次</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    let body = '';

    body += '<div class="sec"><div class="sec-head"><h3>评分表</h3><span>RUBRIC · 1–5</span></div><div class="dim-table">';
    rep.dims.forEach((d) => {
      const na = d.score === null;
      let bars = '';
      for (let i = 1; i <= 5; i++) {
        const cls = !na && i <= d.score ? 'f' + (d.score <= 2 ? ' low' : d.score === 3 ? ' mid' : '') : '';
        bars += '<i class="' + cls + '"></i>';
      }
      body += '<div class="dim-row' + (na ? ' na' : '') + '">' +
        '<div class="dim-name">' + esc(d.key) + '<small>' + esc(d.short) + '</small></div>' +
        '<div><div class="bars">' + bars + '</div><div class="dim-num">' + (na ? '未测' : d.score + ' / 5') + '</div></div>' +
        '<div class="dim-body">' + esc(d.comment) +
          (d.evidence && d.evidence !== '（未提供）' ? '<span class="ev">“' + esc(d.evidence) + '”</span>' : '') +
        '</div></div>';
    });
    body += '</div></div>';

    if (rep.speech && rep.speech.spoken) {
      const unit = currentRound().lang === 'en' ? '词' : '字';
      body += '<div class="speech-card">' +
        '<div class="side-label">口语作答</div>' +
        '<div class="sp-line"><b>' + rep.speech.spoken + ' / ' + rep.speech.total + '</b> 题是开口说的' +
          (rep.speech.rate ? '<span class="sp-rate">平均 ' + rep.speech.rate + ' ' + unit + ' / 分钟</span>' : '') +
          (rep.speech.conf ? '<span class="sp-rate">识别置信度 ' + rep.speech.conf + '</span>' : '') +
        '</div>' +
        '<div class="sp-tip">评分读到的是转写文本：停顿、重复、句子没说完、中文夹进英文，这些都在里面。语速按“' + unit +
          '数 ÷ 开口时长”算，' + (currentRound().lang === 'en' ? '英语日常对话大约 120–160 词/分钟，明显低于 100 通常是卡在组织句子，' : '') +
          '识别置信度低说明机器听不清，多半是吞音、连读糊或重音偏了——这是发音问题的间接线索，不是定论。想真练发音，把每题的“参考回答”念一遍再录一次。</div>' +
      '</div>';
    }

    if (rep.language && (rep.language.note || (rep.language.fixes && rep.language.fixes.length))) {
      body += '<div class="lang-card">' +
        '<div class="side-label">语言表现 · ENGLISH</div>' +
        (rep.language.note ? '<div class="lang-note">' + esc(rep.language.note) + '</div>' : '') +
        (rep.language.fixes && rep.language.fixes.length
          ? '<ul class="fix-list">' + rep.language.fixes.map((f) =>
              '<li><s>' + esc(f.said) + '</s><span class="fix-arrow">→</span><b>' + esc(f.better) + '</b>' +
              (f.why ? '<em>' + esc(f.why) + '</em>' : '') + '</li>').join('') + '</ul>'
          : '') +
        (rep.language.oral ? '<div class="lang-oral"><b>口语</b>' + esc(rep.language.oral) + '</div>' : '') +
      '</div>';
    }

    body += '<div class="sec"><div class="sec-head"><h3>逐题复盘</h3><span>' + rep.questions.length + ' 题</span></div>';
    rep.questions.forEach((q) => {
      const fav = !!state.favSet[q.index];
      const fus = Array.isArray(q.fus) ? q.fus : [];
      body += '<details class="qa"' + (q.index === rep.weakest.index ? ' open' : '') + '>' +
        '<summary><span class="idx">Q' + q.index + '</span>' +
        '<span class="qtext">' + esc(q.question) + '</span>' +
        (fus.length ? '<span class="qtag fu">追问 ' + fus.length + '</span>' : '') +
        (q.over ? '<span class="qtag">超时</span>' : (q.spoken ? '<span class="qtag">语音</span>' : '')) +
        '<span class="qscore">' + q.score + '/5</span><span class="chev">›</span></summary>' +
        '<div class="qa-body"><dl>' +
          ((q.why || q.goal) ? '<div><dt>出题意图</dt><dd class="qwhy">' + esc(q.why || '') +
            (q.goal ? (q.why ? ' · ' : '') + '要问出：' + esc(q.goal) : '') + '</dd></div>' : '') +
          '<div><dt>你答了什么</dt><dd>' + esc(q.digest) + '</dd></div>' +
          '<div><dt>问题在哪</dt><dd class="diag">' + esc(q.diagnosis) + '</dd></div>' +
          '<div><dt>可以这样说</dt><dd class="rewrite">' + esc(q.rewrite) + '</dd></div>' +
          (q.spent ? '<div><dt>用时</dt><dd>' + q.spent + ' 秒' +
            (q.over ? ' · <span style="color:#a83a2c">超时' + (state.cfg.mode === 'real' ? '（限时 ' + state.cfg.limit + ' 秒）' : '') + '</span>' : '') +
            '</dd></div>' : '') +
          (q.spoken && q.seconds ? '<div><dt>口头表达</dt><dd>' + q.seconds + ' 秒' +
            (q.words ? ' · 约 ' + Math.round(q.words / (q.seconds / 60)) + ' ' + (currentRound().lang === 'en' ? '词' : '字') + ' / 分钟' : '') +
            '（语音转写）</dd></div>' : '') +
        '</dl>' +
        (fus.length
          ? '<div class="fu-list"><div class="fu-head">这道题被追了 ' + fus.length + ' 层</div>' +
            fus.map((f, j) =>
              '<div class="fu-item">' +
                '<div class="fu-no">追问 ' + (j + 1) + '</div>' +
                '<div class="fu-body">' +
                  '<div class="fu-q">' + esc(f.q) + '</div>' +
                  (f.a ? '<div class="fu-a"><span>你答</span>' + esc(String(f.a).slice(0, 160)) + '</div>' : '') +
                  (f.verdict ? '<div class="fu-v">' + esc(f.verdict) + '</div>' : '') +
                '</div>' +
              '</div>').join('') +
            '</div>'
          : '') +
        (q.model ? '<div class="model-ans"><div class="ma-label">参考回答 · 可直接模仿</div><div class="ma-body">' + esc(q.model) + '</div></div>' : '') +
        '<div class="qa-tools">' +
          (q.model ? '<button class="ghost" data-copy="' + q.index + '">复制参考回答</button>' : '') +
          '<button class="ghost btn-fav' + (fav ? ' fav-done' : '') + '" data-fav="' + q.index + '">' + (fav ? '已收藏' : '收藏') + '</button>' +
        '</div></div></details>';
    });
    body += '</div>';

    body += '<div class="sec"><div class="sec-head"><h3>最薄弱的一题</h3><span>WEAK SPOT</span></div>' +
      '<div class="weak-card">' +
        '<div class="wk-label">Q' + rep.weakest.index + ' · ' + esc(rep.questions[rep.weakest.index - 1] ? rep.questions[rep.weakest.index - 1].question : '') + '</div>' +
        '<h4>' + esc(rep.weakest.why) + '</h4>' +
        '<p>下面这句是重放时它会再问你一次的。答得比刚才硬，才算过关。</p>' +
        '<div class="reprobe"><b>追问</b>' + esc(rep.weakest.reprobe) + '</div>' +
        '<button class="primary" id="btnDrill">重放这一题 →</button>' +
      '</div></div>';

    body += '<div class="sec"><div class="sec-head"><h3>下一轮训练重点</h3><span>NEXT</span></div><div class="focus-grid">';
    rep.focus.forEach((f, i) => {
      const drill = rep.drills[i];
      body += '<div class="focus-item"><div class="n">' + (i + 1) + '</div><div>' +
        '<b>' + esc(f) + '</b>' +
        (drill && drill.how ? '<span>' + esc(drill.how) + '</span>' : '') +
        '</div></div>';
    });
    body += '</div></div>';

    $('reportBody').innerHTML = body;

    $('reportBody').querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => {
        const q = rep.questions.find((x) => String(x.index) === b.dataset.copy);
        if (!q) return;
        const txt = q.model || q.rewrite || '';
        if (!txt) return;
        navigator.clipboard.writeText(txt).then(
          () => toast('参考回答已复制'),
          () => toast('复制失败，手动选中也可以', true)
        );
      };
    });
    $('reportBody').querySelectorAll('[data-fav]').forEach((b) => {
      b.onclick = () => {
        const q = rep.questions.find((x) => String(x.index) === b.dataset.fav);
        if (q) saveFavorite(q);
      };
    });

    const saved = !!state.savedId;
    $('reportActions').innerHTML =
      '<button class="primary" id="btnAgain">再来一轮</button>' +
      '<button class="ghost" id="btnSave"' + (saved ? ' disabled' : '') + '>' + (saved ? '已保存到记录' : '保存到练习记录') + '</button>' +
      '<button class="ghost" id="btnCopy">复制复盘</button>' +
      '<button class="ghost" id="btnDownload">下载 Markdown</button>' +
      '<button class="ghost" id="btnReportHome">回到选择台</button>' +
      '<div class="report-note">' + (state.user ? '已登录，复盘会自动保存到云端。' : '未登录：这条复盘只在当前页面，登录后才会存到云端。') + '</div>';

    const drillBtn = $('btnDrill');
    if (drillBtn) drillBtn.onclick = startDrill;
    $('btnAgain').onclick = () => { show('setup'); renderSetup(); };
    $('btnSave').onclick = () => saveReport();
    $('btnCopy').onclick = copyReport;
    $('btnDownload').onclick = downloadReport;
    $('btnReportHome').onclick = goHome;
  }

  function reportMarkdown() {
    const rep = state.report, c = state.cfg;
    const g = gradeOf(rep.total);
    let md = '# 面试复盘：' + c.job + ' · ' + sceneOfRound(c.round).label + ' / ' + currentRound().label + '\n\n';
    md += '- 得分：**' + rep.total + ' / 100**（' + g.label + '）\n';
    md += '- 压力档：' + PRESSURES[c.pressure].label + '｜面试官：' + c.persona + '\n';
    md += '- 模式：' + (c.mode === 'real' ? '实战，每题限时 ' + c.limit + ' 秒' : '练习，不限时') + '\n';
    if (rep.speech && rep.speech.spoken) {
      md += '- 口语作答：' + rep.speech.spoken + '/' + rep.speech.total + ' 题（语音转写）' +
        (rep.speech.rate ? '，平均 ' + rep.speech.rate + ' ' + (currentRound().lang === 'en' ? '词' : '字') + '/分' : '') +
        (rep.speech.conf ? '，识别置信度 ' + rep.speech.conf : '') + '\n';
    }
    if (rep.fuTotal) md += '- 被追问：' + rep.fuTotal + ' 次\n';
    md += '- 日期：' + (rep.createdAt || new Date()).toLocaleString('zh-CN') + '\n\n';
    md += '## 总评\n\n' + rep.verdict + '\n\n';
    md += '## 评分表\n\n| 维度 | 分数 | 评语 | 依据 |\n| --- | --- | --- | --- |\n';
    rep.dims.forEach((d) => { md += '| ' + d.key + ' | ' + (d.score === null ? '—' : d.score + '/5') + ' | ' + d.comment.replace(/\|/g, '/') + ' | ' + (d.evidence || '').replace(/\|/g, '/') + ' |\n'; });
    md += '\n## 逐题复盘\n\n';
    rep.questions.forEach((q) => {
      md += '### Q' + q.index + (q.spoken ? '［语音］' : '') + '：' + q.question + '\n\n';
      md += '- 你的回答：' + q.digest + '\n';
      if (q.why || q.goal) md += '- 出题意图：' + (q.why || '') + (q.goal ? (q.why ? ' · ' : '') + '要问出：' + q.goal : '') + '\n';
      md += '- 问题：' + q.diagnosis + '\n';
      md += '- 可以这样说：' + q.rewrite + '\n';
      if (q.spent) md += '- 用时：' + q.spent + ' 秒' + (q.over ? '（超时）' : '') + '\n';
      if (Array.isArray(q.fus) && q.fus.length) {
        md += '- 被追问 ' + q.fus.length + ' 层：\n';
        q.fus.forEach((f, j) => {
          md += '  - 追问 ' + (j + 1) + '：' + f.q + '\n';
          if (f.a) md += '    - 你答：' + String(f.a).replace(/\n+/g, ' ') + '\n';
          if (f.verdict) md += '    - 暴露了：' + f.verdict + '\n';
        });
      }
      if (q.model) md += '- 参考回答：' + q.model + '\n';
      md += '\n';
    });
    if (rep.language && (rep.language.note || (rep.language.fixes && rep.language.fixes.length))) {
      md += '## 语言表现（English）\n\n';
      if (rep.language.note) md += rep.language.note + '\n\n';
      (rep.language.fixes || []).forEach((f) => {
        md += '- ~~' + f.said + '~~ → **' + f.better + '**' + (f.why ? '（' + f.why + '）' : '') + '\n';
      });
      if (rep.language.oral) md += '\n口语：' + rep.language.oral + '\n';
      md += '\n';
    }
    md += '## 最薄弱的一题\n\n' + rep.weakest.why + '\n\n> 重放追问：' + rep.weakest.reprobe + '\n\n';
    md += '## 下一轮训练重点\n\n';
    rep.focus.forEach((f, i) => { md += (i + 1) + '. ' + f + (rep.drills[i] && rep.drills[i].how ? '——' + rep.drills[i].how : '') + '\n'; });
    return md;
  }

  async function copyReport() {
    const md = reportMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      toast('复盘已复制到剪贴板');
    } catch (e) {
      toast('复制失败，可以改用下载', true);
    }
  }

  function downloadReport() {
    const md = reportMarkdown();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '面试复盘_' + state.cfg.job + '_' + new Date().toISOString().slice(0, 10) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ================= 保存 / 历史 ================= */
  async function saveReportSilently() {
    if (!state.user) { state.pendingSave = true; return; }
    await saveReport(true);
  }

  async function saveReport(silent) {
    const rep = state.report;
    if (!rep) return;
    if (!state.user) { state.pendingSave = true; openAuth(); return; }
    if (state.savedId) { if (!silent) toast('这条复盘已经保存过了'); return; }
    const payload = {
      job_title: state.cfg.job,
      round_type: state.cfg.round,
      pressure: state.cfg.pressure,
      interviewer: state.cfg.persona,
      total_score: rep.total,
      turns: rep.turns || state.turns,
      review: { verdict: rep.verdict, questions: rep.questions, weakest: rep.weakest, drills: rep.drills, speech: rep.speech || null, language: rep.language || null, fuTotal: rep.fuTotal || 0, mode: state.cfg.mode, limit: state.cfg.limit },
      scores: rep.dims,
      focus: rep.focus,
      duration_sec: rep.durationSec || 0,
      owner_name: (state.user && state.user.name) || null
    };
    const { data, error } = await cloud.database.from('interview_sessions').insert(payload).select();
    if (error) {
      if (!silent) toast('保存失败：' + (error.message || error.code || '未知错误'), true);
      return;
    }
    state.savedId = (data && data[0] && data[0].id) || 'saved';
    state.pendingSave = false;
    if (state.screen === 'report') renderReport();
    if (!silent) toast('已保存到练习记录');
  }

  async function openHistory() {
    show('history');
    const list = $('historyList');
    if (!state.user) {
      list.innerHTML = '<div class="empty-state">练习记录存在云端，登录后才能查看。<br><br><button class="primary" id="btnHistLogin">登录</button></div>';
      $('btnHistLogin').onclick = openAuth;
      return;
    }
    list.innerHTML = '<div class="empty-state">加载中…</div>';
    const { data, error } = await cloud.database
      .from('interview_sessions')
      .select('id, job_title, round_type, pressure, interviewer, total_score, created_at, scores, review, focus, turns, duration_sec')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) {
      list.innerHTML = '<div class="empty-state">读取失败：' + esc(error.message || '未知错误') + '</div>';
      return;
    }
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty-state">还没有记录。回去面一场，它会把复盘存到这里。</div>';
      return;
    }
    list.innerHTML = '';
    data.forEach((row) => {
      const total = Math.round(Number(row.total_score) || 0);
      const el = document.createElement('div');
      el.className = 'hist-row';
      el.innerHTML =
        '<div><div class="ht">' + esc(row.job_title) + ' · ' + esc((ROUNDS[row.round_type] || {}).label || row.round_type) + '</div>' +
        '<div class="hm">' + esc(sceneOfRound(row.round_type).label) + ' · ' +
        esc(PRESSURES[row.pressure] ? PRESSURES[row.pressure].label : '') + ' · ' +
        new Date(row.created_at).toLocaleString('zh-CN') + '</div></div>' +
        '<div class="hist-score' + (total < 60 ? ' low' : '') + '">' + total + '</div>';
      el.onclick = () => reopenReport(row);
      list.appendChild(el);
    });
  }

  function reopenReport(row) {
    const roundKey = ROUNDS[row.round_type] ? row.round_type : 'behavioral';
    const turns = Array.isArray(row.turns) ? row.turns : [];
    const mainQs = turns.filter((t) => t.role === 'interviewer' && !t.sub).length;
    state.turns = turns;
    state.sub = 0;
    state.fuTotal = turns.filter((t) => t.role === 'interviewer' && t.sub).length;
    state.cfg = {
      scene: ROUNDS[roundKey].scene,
      job: row.job_title,
      round: roundKey,
      pressure: PRESSURES[row.pressure] ? row.pressure : 'standard',
      persona: row.interviewer || ROUNDS[roundKey].personas[0],
      total: Math.max(1, mainQs),
      background: '',
      mode: (row.review && row.review.mode === 'real') ? 'real' : 'practice',
      limit: (row.review && Number(row.review.limit)) || 90
    };
    const review = row.review || {};
    const stored = Array.isArray(row.scores) ? row.scores : [];
    const dims = dimsOfRound(roundKey).map((rd, i) => {
      const d = stored.find((x) => x && x.key === rd.key) || stored[i] || {};
      return { key: rd.key, short: rd.short, score: dimScore(d.score), comment: d.comment || '', evidence: d.evidence || '' };
    });
    const byQ = groupByQuestion(turns);
    const questions = (review.questions || []).map((q, i) => {
      const slot = byQ[i] || { a: null };
      const ct = slot.a;
      return Object.assign({}, q, {
        spoken: !!(ct && ct.via === 'voice'),
        seconds: ct ? (ct.seconds || 0) : 0,
        words: ct ? (ct.words || 0) : 0,
        fus: Array.isArray(q.fus) ? q.fus : []
      });
    });
    state.report = {
      verdict: review.verdict || '',
      dims: dims,
      total: Math.round(Number(row.total_score) || 0),
      questions: questions,
      speech: review.speech || null,
      language: review.language || null,
      fuTotal: state.fuTotal,
      weakest: review.weakest || { index: 1, question: '', why: '', reprobe: '' },
      focus: Array.isArray(row.focus) ? row.focus : [],
      drills: review.drills || [],
      durationSec: row.duration_sec || 0,
      createdAt: new Date(row.created_at),
      turns: turns
    };
    state.savedId = row.id;
    renderReport();
    show('report');
  }

  /* ================= 收藏 ================= */
  function reportCandidateText(index) {
    const turns = (state.report && state.report.turns) || state.turns;
    const t = turns.find((x) => x.role === 'candidate' && x.qIndex === index && !x.sub);
    return t && !t.skipped ? t.text : '';
  }

  async function saveFavorite(q) {
    if (!q || !state.report) return;
    if (!state.user) {
      state.pendingFav = q.index;
      openAuth();
      return;
    }
    if (state.favSet[q.index]) { toast('这一题已经收藏过了'); return; }
    const answer = q.model || q.rewrite || '';
    if (!answer) { toast('这题没有参考回答可收藏', true); return; }
    const payload = {
      question: q.question,
      model_answer: answer,
      my_answer: reportCandidateText(q.index),
      job: state.cfg.job,
      round: state.cfg.round,
      scene: state.cfg.scene,
      score: q.score || null
    };
    const { error } = await cloud.database.from('saved_answers').insert(payload).select();
    if (error) { toast('收藏失败：' + (error.message || '未知错误'), true); return; }
    state.favSet[q.index] = true;
    const btn = document.querySelector('[data-fav="' + q.index + '"]');
    if (btn) { btn.textContent = '已收藏'; btn.classList.add('fav-done'); }
    toast('已收藏，面试前在「我的收藏」里翻一遍');
  }

  async function openSaved() {
    show('saved');
    const list = $('savedList');
    if (!state.user) {
      list.innerHTML = '<div class="empty-state">收藏存在云端，登录后才能看。<br><br><button class="primary" id="btnSavedLogin">登录</button></div>';
      $('btnSavedLogin').onclick = openAuth;
      return;
    }
    list.innerHTML = '<div class="empty-state">加载中…</div>';
    const { data, error } = await cloud.database
      .from('saved_answers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      list.innerHTML = '<div class="empty-state">读取失败：' + esc(error.message || '未知错误') + '</div>';
      return;
    }
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty-state">还没有收藏。复盘里每题下面有「收藏」，点一下就会存到这里。</div>';
      return;
    }
    list.innerHTML = '';
    data.forEach((row) => {
      const roundLabel = (ROUNDS[row.round] || {}).label || row.round || '';
      const el = document.createElement('div');
      el.className = 'saved-card';
      el.innerHTML =
        '<div class="sc-q">' + esc(row.question) + '</div>' +
        '<div class="sc-meta">' + esc(row.job || '') + ' · ' + esc(roundLabel) +
          (row.score ? ' · 当时 ' + row.score + '/5' : '') +
          ' · ' + new Date(row.created_at).toLocaleDateString('zh-CN') + '</div>' +
        '<div class="sc-a">' + esc(row.model_answer) + '</div>' +
        (row.my_answer ? '<details class="sc-mine"><summary>我当时怎么答的</summary><div class="sc-a">' + esc(row.my_answer) + '</div></details>' : '') +
        '<div class="sc-tools">' +
          '<button class="ghost small" data-act="copy" type="button">复制参考回答</button>' +
          '<button class="ghost small" data-act="del" type="button">删除</button>' +
        '</div>';
      el.querySelector('[data-act="copy"]').onclick = () => {
        navigator.clipboard.writeText(row.model_answer).then(
          () => toast('已复制'),
          () => toast('复制失败，手动选中也可以', true)
        );
      };
      el.querySelector('[data-act="del"]').onclick = async () => {
        if (!window.confirm('删除这条收藏？')) return;
        const res = await cloud.database.from('saved_answers').delete().eq('id', row.id);
        if (res.error) { toast('删除失败：' + (res.error.message || '未知错误'), true); return; }
        el.remove();
        toast('已删除');
      };
      list.appendChild(el);
    });
  }

  /* ================= 重放训练 ================= */
  function startDrill() {
    const rep = state.report;
    if (!rep) return;
    const idx = rep.weakest.index;
    const q = rep.questions[idx - 1];
    const baseAnswer = '';
    // 从对话记录里找回那一题的原始回答
    let found = '';
    let seenQ = 0;
    (rep.turns || state.turns).forEach((t) => {
      if (t.role === 'interviewer') seenQ += 1;
      if (seenQ === idx && t.role === 'candidate') found = t.text;
    });

    state.drill = {
      step: 0,
      weakest: {
        index: idx,
        question: (q && q.question) || rep.weakest.question,
        why: rep.weakest.why,
        reprobe: rep.weakest.reprobe
      },
      before: found || (q && q.digest) || '（未记录）',
      baseAnswer: found || '',
      turns: []
    };

    drillVoice.stop();
    drillVoice.reset();
    $('drillChat').innerHTML = '';
    $('drillInput').value = '';
    $('drillMeta').innerHTML = '<b>' + esc(state.cfg.job) + '</b><span class="pill">重放训练</span><span class="pill rust">Q' + idx + '</span>';
    $('drillSide').innerHTML =
      '<div class="side-card"><div class="side-label">上次诊断</div><div class="side-focus">' + esc(rep.weakest.why) + '</div></div>' +
      '<div class="side-card"><div class="side-label">上次得分</div><div class="side-strong">' + ((q && q.score) || '-') + ' / 5</div>' +
      '<div class="side-note">这次把证据补齐，分数会重算。</div></div>';
    show('drill');

    // 面试官把原问题再问一遍（不调模型，保证和上次一字不差）
    const body = addMessage('interviewer', state.drill.weakest.question, null, $('drillChat'));
    body.dataset.raw = '1';
    state.drill.turns.push({ role: 'interviewer', text: state.drill.weakest.question });
    $('drillInput').focus();
  }

  async function drillSubmit() {
    const d = state.drill;
    if (!d) return;
    if (drillVoice.listening || drillVoice.wantListening) drillVoice.stop();
    const input = $('drillInput');
    const text = input.value.trim();
    if (text.length < 2) { toast('写点东西再发', true); return; }
    const meta = drillVoice.used() ? { via: 'voice', seconds: drillVoice.seconds, words: drillVoice.words } : null;
    addMessage('candidate', text, { via: meta ? 'voice' : '', seconds: meta ? meta.seconds : 0 }, $('drillChat'));
    const turn = { role: 'candidate', text: text };
    if (meta) Object.assign(turn, meta);
    d.turns.push(turn);
    drillVoice.reset();
    input.value = '';
    d.step += 1;

    if (d.step === 1) {
      // 追问一次
      const sys = buildDrillSystem(state.cfg, d.weakest);
      const msgs = [{ role: 'system', content: sys }];
      d.turns.forEach((t) => msgs.push({ role: t.role === 'interviewer' ? 'assistant' : 'user', content: t.text }));
      const body = addMessage('interviewer', '', null, $('drillChat'));
      let first = true;
      try {
        const out = await streamChat({
          messages: msgs,
          temperature: 0.85,
          onDelta: (delta, full) => {
            if (first) { body.textContent = ''; first = false; }
            body.textContent = cleanInterviewerText(full);
            scrollBottom($('drillChat'));
          }
        });
        const q = cleanInterviewerText(out) || '这个数字你从哪拿到的？';
        body.textContent = q;
        d.turns.push({ role: 'interviewer', text: q });
      } catch (err) {
        body.textContent = '（追问失败：' + llmErrorMessage(err) + '）';
      }
      $('drillInput').focus();
      return;
    }

    // 第二次回答后给出对比结论
    $('btnDrillSend').disabled = true;
    const body = addMessage('interviewer', '', null, $('drillChat'));
    body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    try {
      const judge = await requestJSON(
        '你是严格的面试教练，只输出 JSON 对象，所有文字用中文，不使用代码块。',
        buildDrillJudgePrompt(state.cfg, d.weakest, d.baseAnswer, text),
        0.4
      );
      body.remove();
      renderDrillResult(judge, text);
      const st = $('drillSide');
      const after = clampScore(judge.after);
      st.insertAdjacentHTML('beforeend',
        '<div class="side-card"><div class="side-label">这次</div><div class="side-strong">' + after + ' / 5</div>' +
        '<div class="side-note">' + esc(judge.one_line || '') + '</div></div>');
    } catch (err) {
      body.textContent = '（评分失败：' + llmErrorMessage(err) + '）';
    }
    $('btnDrillSend').disabled = false;
  }

  function renderDrillResult(judge, newAnswer) {
    const d = state.drill;
    const before = clampScore(judge.before);
    const after = clampScore(judge.after);
    const wrap = document.createElement('div');
    wrap.className = 'drill-result';
    const imp = (judge.improved || []).map((x) => '<li>' + esc(x) + '</li>').join('');
    const stl = (judge.still || []).map((x) => '<li>' + esc(x) + '</li>').join('');
    wrap.innerHTML =
      '<div class="dr-top"><div><div class="dr-num">' + before + '</div><div class="dr-cap">上次</div></div>' +
      '<div class="dr-arrow">→</div>' +
      '<div><div class="dr-num after">' + after + '</div><div class="dr-cap">这次</div></div></div>' +
      '<h4>' + esc(judge.one_line || '') + '</h4>' +
      (imp ? '<div class="side-label">补上了</div><ul class="drill-list">' + imp + '</ul>' : '') +
      (stl ? '<div class="side-label">还差</div><ul class="drill-list">' + stl + '</ul>' : '') +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button class="ghost small" id="btnDrillAgain">再放一遍</button>' +
      '<button class="primary" id="btnDrillBack">回到复盘</button></div>';
    $('drillChat').appendChild(wrap);
    scrollBottom($('drillChat'));
    $('btnDrillAgain').onclick = () => {
      startDrill();
    };
    $('btnDrillBack').onclick = () => { renderReport(); show('report'); };
  }

  /* ================= 登录 ================= */
  let pendingOtp = null;
  let countdownTimer = null;

  function openAuth() {
    $('authModal').classList.remove('hidden');
    $('authError').classList.add('hidden');
    $('phoneInput').focus();
  }
  function closeAuth() { $('authModal').classList.add('hidden'); }

  function authError(msg) {
    const el = $('authError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function bindAuth() {
    $('authClose').onclick = closeAuth;
    $('authModal').addEventListener('click', (e) => { if (e.target === $('authModal')) closeAuth(); });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const isPhone = tab.dataset.tab === 'phone';
        $('tabPhone').classList.toggle('hidden', !isPhone);
        $('tabEmail').classList.toggle('hidden', isPhone);
        pendingOtp = null;
      };
    });

    $('phoneInput').addEventListener('input', () => {
      $('phoneError').classList.add('hidden');
      $('phoneInput').value = $('phoneInput').value.replace(/[^\d]/g, '').slice(0, 11);
    });

    $('btnSendCode').onclick = sendCode;
    $('btnAuthSubmit').onclick = submitCode;
    $('btnWechat').onclick = wechatLogin;
    $('btnLogin').onclick = openAuth;
    $('btnLogout').onclick = async () => {
      await cloud.auth.signOut();
      state.user = null;
      state.presets = [];
      state.presetsLoaded = false;
      state.favSet = {};
      updateAuthUI();
      if (state.screen === 'setup') renderPresetBar();
      toast('已退出登录');
      if (state.screen === 'history') openHistory();
    };
  }

  function startCountdown(btn) {
    let left = 60;
    btn.disabled = true;
    btn.textContent = left + 's';
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(countdownTimer);
        btn.disabled = false;
        btn.textContent = '获取验证码';
      } else {
        btn.textContent = left + 's';
      }
    }, 1000);
  }

  async function sendCode() {
    const isPhone = !$('tabPhone').classList.contains('hidden');
    const phone = $('phoneInput').value.trim();
    const email = $('emailInput').value.trim();
    if (isPhone) {
      if (!/^1\d{10}$/.test(phone)) {
        $('phoneError').classList.remove('hidden');
        return;
      }
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      authError('请输入正确的邮箱地址');
      return;
    }
    const btn = $('btnSendCode');
    btn.disabled = true;
    try {
      const sent = isPhone ? await cloud.auth.sendOtp({ phone }) : await cloud.auth.sendOtp({ email });
      if (sent.error) {
        authError(sent.error.message || '验证码发送失败');
        btn.disabled = false;
        return;
      }
      pendingOtp = isPhone
        ? { kind: 'phone', phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
        : { kind: 'email', email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
      startCountdown(btn);
      toast('验证码已发送');
    } catch (e) {
      authError(e.message || '验证码发送失败');
      btn.disabled = false;
    }
  }

  async function submitCode() {
    const code = $('codeInput').value.trim();
    if (!pendingOtp) { authError('请先获取验证码'); return; }
    if (!/^\d{4,6}$/.test(code)) { authError('请输入收到的验证码'); return; }
    const btn = $('btnAuthSubmit');
    btn.disabled = true;
    try {
      const payload = {
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token: code
      };
      if (pendingOtp.kind === 'phone') payload.phone = pendingOtp.phone; else payload.email = pendingOtp.email;
      const res = await cloud.auth.verifyOtp(payload);
      if (res.error) {
        authError(res.error.message || '验证失败，检查一下验证码');
        btn.disabled = false;
        return;
      }
      pendingOtp = null;
      $('codeInput').value = '';
      state.user = res.data.user;
      updateAuthUI();
      closeAuth();
      toast('已登录');
      afterLogin();
    } catch (e) {
      authError(e.message || '登录失败');
    }
    btn.disabled = false;
  }

  async function wechatLogin() {
    try {
      const back = new URL(location.href);
      back.pathname = '/';
      ['code', 'state', 'provider'].forEach((k) => back.searchParams.delete(k));
      const res = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: back.toString() });
      if (res.error) { authError(res.error.message || '微信登录未开启'); return; }
      location.assign(res.data.url);
    } catch (e) {
      authError('微信登录需要部署到正式域名后才能使用。');
    }
  }

  function updateAuthUI() {
    const hasUser = !!state.user;
    $('btnLogin').classList.toggle('hidden', hasUser);
    $('userChip').classList.toggle('hidden', !hasUser);
    if (hasUser) $('userName').textContent = state.user.name || (state.user.phone ? '已登录' : (state.user.email ? '已登录' : '已登录'));
  }

  async function afterLogin() {
    if (state.pendingSave && state.report) {
      await saveReport(true);
      toast('已保存到练习记录');
    }
    if (state.pendingFav && state.report) {
      const q = state.report.questions.find((x) => x.index === state.pendingFav);
      state.pendingFav = null;
      if (q) await saveFavorite(q);
    }
    await loadPresets(true);
    if (state.screen === 'history') openHistory();
    if (state.screen === 'saved') openSaved();
  }

  async function restoreAuth() {
    if (!cloud) return;
    const url = new URL(location.href);
    const hasCb = url.searchParams.has('code') || url.searchParams.has('error');
    if (hasCb) {
      const provider = url.searchParams.get('provider');
      if (provider !== 'wechat' && provider !== 'workbuddy') {
        authError('登录回调缺少有效的登录方式，请重新登录。');
      } else {
        const fn = provider === 'wechat' ? cloud.auth.handleWechatWebCallback : cloud.auth.handleWorkBuddyCallback;
        if (typeof fn !== 'function') {
          authError('当前 SDK 不支持该登录方式。');
        } else {
          const res = await fn.call(cloud.auth).catch((e) => ({ error: e }));
          if (res && res.error) {
            authError(res.error.message || '登录失败');
            openAuth();
          } else if (res && res.session) {
            state.user = res.session.user;
            ['code', 'state', 'provider'].forEach((k) => url.searchParams.delete(k));
            history.replaceState(null, '', url.pathname + url.search + url.hash);
            updateAuthUI();
            afterLogin();
            return;
          }
        }
      }
    }
    const { data: session } = await cloud.auth.getSession().catch(() => ({ data: null }));
    if (session && session.user) {
      state.user = session.user;
      updateAuthUI();
      await loadPresets(true);
    }
    cloud.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') {
        state.user = null;
        state.presets = [];
        state.presetsLoaded = false;
        updateAuthUI();
      } else if (s && s.user) {
        state.user = s.user;
        updateAuthUI();
        loadPresets(true);
      }
    });
  }

  /* 调试开关：只有显式打开 window.__IC_DEBUG__ 时才暴露内部状态，正常访问不受影响 */
  if (window.__IC_DEBUG__) {
    window.__IC__ = {
      state: state, startInterview: startInterview, submitAnswer: submitAnswer,
      askQuestion: askQuestion, askFollowup: askFollowup, finishInterview: finishInterview,
      normalizeReport: normalizeReport, renderReport: renderReport, fuBudgetFor: fuBudgetFor,
      collectClaims: collectClaims, preparePlan: preparePlan, show: show, stopTimer: stopTimer,
      groupByQuestion: groupByQuestion, renderSetup: renderSetup, renderSummary: renderSummary,
      renderBrief: renderBrief, playMeme: playMeme
    };
  }

  /* ================= 启动 ================= */
  function bindRoom() {
    voice.setup();
    drillVoice.setup();
    $('btnSend').onclick = () => submitAnswer(false);
    $('btnSkip').onclick = () => submitAnswer(true);
    $('answerInput').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitAnswer(false); }
    });
    $('btnFinish').onclick = () => {
      const answered = state.turns.filter((t) => t.role === 'candidate').length;
      if (answered < 1) { toast('至少回答一题再评分', true); return; }
      $('btnFinish').disabled = true;
      finishInterview();
    };
    $('btnDrillSend').onclick = drillSubmit;
    $('btnDrillExit').onclick = () => { renderReport(); show('report'); };
    const exit = $('btnExit');
    if (exit) exit.onclick = goHome;
    const drillHome = $('btnDrillHome');
    if (drillHome) drillHome.onclick = goHome;
    $('drillInput').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); drillSubmit(); }
    });
  }

  (async function boot() {
    initCloud();
    renderSetup();
    bindSetup();
    bindAuth();
    bindRoom();
    if (!cloud) { toast('云服务 SDK 未加载，请检查网络后刷新', true); return; }
    try { await restoreAuth(); } catch (e) { /* 静默 */ }
    try { await ensureModel(); } catch (e) { toast(llmErrorMessage(e), true); }
  })();
})();
