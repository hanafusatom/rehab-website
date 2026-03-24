/**
 * RehabCMS - インライン編集エンジン
 * クリックしてその場で編集できるWordPress風CMS
 *
 * 使い方：
 *   URLに ?edit=1 を付けるか、ページ下部の「編集モード」ボタンをクリック
 *   → パスワード認証後に編集開始
 *   編集可能な要素をクリック → その場で編集
 *   「保存」ボタンで全変更をlocalStorageに保存
 *   「JSONで書き出し」でサーバー反映用ファイルをダウンロード
 *
 * セキュリティ：
 *   - パスワードはSHA-256ハッシュのみ保存（平文なし）
 *   - セッションは4時間有効（sessionStorage使用、ブラウザを閉じると自動消去）
 *   - 初回アクセス時にパスワード設定ダイアログが表示されます
 *   - パスワードを忘れた場合：ブラウザのlocalStorageから rehab_cms_pw_hash を削除してリセット
 */

(function() {
  'use strict';

  // ── 設定 ──────────────────────────────────────────
  const STORAGE_KEY       = 'rehab_cms_data';
  const EDIT_PARAM        = 'edit';
  const AUTH_SESSION_KEY  = 'rehab_cms_auth';     // sessionStorage: セッションタイムスタンプ
  const PASSWORD_HASH_KEY = 'rehab_cms_pw_hash';  // localStorage: SHA-256ハッシュ
  const SESSION_DURATION  = 4 * 60 * 60 * 1000;  // 4時間（ミリ秒）

  // ── 状態 ──────────────────────────────────────────
  let isEditMode = false;
  let isDirty    = false;
  let savedData  = {};

  // ── 初期化 ────────────────────────────────────────
  async function init() {
    const params = new URLSearchParams(location.search);

    // サーバーの cms-data.json を優先して読み込む（全員に同じ内容を表示）
    let loadedFromServer = false;
    try {
      const res = await fetch('cms-data.json?_=' + Date.now());
      if (res.ok) {
        const serverData = await res.json();
        Object.entries(serverData).forEach(([k, v]) => {
          if (!k.startsWith('_')) savedData[k] = v;
        });
        loadedFromServer = true;
      }
    } catch(e) { /* サーバーから読めない場合はlocalStorageにフォールバック */ }

    if (!loadedFromServer) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try { savedData = JSON.parse(stored); } catch(e) {}
      }
    }

    // 保存データをページに反映
    applyStoredData();

    // 編集モード起動判定（認証チェック付き）
    // URLに ?edit=1 を付けた場合のみ編集モードを起動
    if (params.get(EDIT_PARAM) === '1') {
      requireAuth().then(ok => { if (ok) enableEditMode(); });
    }
  }

  // ── 保存データをページに反映 ─────────────────────
  function applyStoredData() {
    Object.entries(savedData).forEach(([key, value]) => {
      const el = document.querySelector(`[data-cms="${key}"]`);
      if (!el) return;
      if (el.tagName === 'IMG') {
        el.src = value;
        // onerrorで非表示にされた画像を再表示
        el.style.display = 'block';
        const placeholder = el.nextElementSibling;
        if (placeholder && (placeholder.classList.contains('placeholder') || placeholder.classList.contains('placeholder-icon'))) {
          placeholder.style.display = 'none';
        }
      } else if (el.tagName === 'CANVAS' && el.dataset.cmsType === 'resident-name') {
        // 医員名：data-name属性を更新してcanvasを再描画
        const card = el.closest('.staff-card-compact');
        if (card) {
          card.setAttribute('data-name', value);
          if (typeof renderNameCanvas === 'function') {
            const doRender = () => renderNameCanvas(el, value);
            if (document.fonts && document.fonts.ready) {
              document.fonts.ready.then(doRender);
            } else {
              setTimeout(doRender, 100);
            }
          }
        }
      } else {
        el.innerHTML = value;
      }
    });
  }

  // ── 編集モード ON ─────────────────────────────────
  function enableEditMode() {
    isEditMode = true;
    document.body.classList.add('cms-edit-mode');
    injectToolbar();
    makeEditable();
    addHoverEffects();
    showToast('編集モードが有効になりました。クリックして編集してください。', 'info');
  }

  // ── 編集モード OFF ────────────────────────────────
  function disableEditMode() {
    isEditMode = false;
    document.body.classList.remove('cms-edit-mode');
    document.querySelectorAll('[contenteditable]').forEach(el => {
      el.removeAttribute('contenteditable');
    });
    const toolbar = document.getElementById('cms-toolbar');
    if (toolbar) toolbar.remove();
  }

  // ── ツールバー注入 ────────────────────────────────
  function injectToolbar() {
    const old = document.getElementById('cms-toolbar');
    if (old) old.remove();
    const tb = document.createElement('div');
    tb.id = 'cms-toolbar';
    tb.innerHTML = `
      <div class="cms-tb-inner">
        <div class="cms-tb-left">
          <div class="cms-tb-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            RehabCMS
          </div>
          <span class="cms-tb-page">${document.title.split(' |')[0]}</span>
        </div>
        <div class="cms-tb-center">
          <span class="cms-tb-hint">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
            </svg>
            テキストをクリックして編集
          </span>
        </div>
        <div class="cms-tb-right">
          <div id="cms-dirty-indicator" class="cms-dirty" style="display:none">
            ● 未保存の変更あり
          </div>
          <button id="cms-btn-preview" class="cms-btn cms-btn-ghost" onclick="window.cmsPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            プレビュー
          </button>
          <button id="cms-btn-export" class="cms-btn cms-btn-ghost" onclick="window.cmsExport()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            書き出し
          </button>
          <button id="cms-btn-save" class="cms-btn cms-btn-primary" onclick="window.cmsSave()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
            保存する
          </button>
          <button class="cms-btn cms-btn-logout" onclick="window.cmsLogout()" title="ログアウト（セッション終了）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            ログアウト
          </button>
          <button class="cms-btn cms-btn-exit" onclick="window.cmsExit()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            終了
          </button>
        </div>
      </div>
    `;
    document.body.prepend(tb);
  }

  // ── 編集開始ボタン（通常時） ──────────────────────
  function injectToggleButton() {
    const old = document.getElementById('cms-toggle-btn');
    if (old) old.remove();
    const btn = document.createElement('div');
    btn.id = 'cms-toggle-btn';
    btn.innerHTML = `
      <button onclick="window.cmsStartEdit()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        ✏️ 編集モード
      </button>
    `;
    document.body.appendChild(btn);
  }

  // ── 編集可能にする ────────────────────────────────
  function makeEditable() {
    document.querySelectorAll('[data-cms]').forEach(el => {
      const key = el.dataset.cms;
      const type = el.dataset.cmsType || 'text';

      if (type === 'image') {
        makeImageEditable(el, key);
        return;
      }

      if (type === 'resident-name') {
        makeResidentNameEditable(el, key);
        return;
      }

      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');

      // 既存のフォーカス処理
      el.addEventListener('focus', () => {
        el.classList.add('cms-focused');
        showFloatingToolbar(el);
      });

      el.addEventListener('blur', () => {
        el.classList.remove('cms-focused');
        // 変更を記録
        const newVal = el.innerHTML;
        if (savedData[key] !== newVal) {
          savedData[key] = newVal;
          markDirty();
        }
        hideFloatingToolbar();
      });

      el.addEventListener('input', () => {
        savedData[key] = el.innerHTML;
        markDirty();
      });

      // Enterキーの挙動（段落モード or 単行モード）
      if (type === 'line') {
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); }
        });
      }
    });
  }

  // ── 医員名編集（canvas要素をクリックで編集） ────
  function makeResidentNameEditable(el, key) {
    el.style.cursor = 'pointer';
    el.title = 'クリックして氏名を変更';
    el.addEventListener('click', () => {
      const card = el.closest('.staff-card-compact');
      const currentName = card ? card.getAttribute('data-name') : '';
      const newName = prompt('医員の氏名を入力してください：', currentName);
      if (newName === null || newName === currentName) return;
      if (card) card.setAttribute('data-name', newName);
      if (typeof renderNameCanvas === 'function') {
        const doRender = () => renderNameCanvas(el, newName);
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(doRender);
        } else {
          setTimeout(doRender, 100);
        }
      }
      savedData[key] = newName;
      markDirty();
    });
  }

  // ── 画像圧縮 ─────────────────────────────────────
  function compressImage(file, maxWidth, quality) {
    maxWidth = maxWidth || 800;
    quality  = quality  || 0.8;
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ── 画像編集 ─────────────────────────────────────
  function makeImageEditable(el, key) {
    el.style.cursor = 'pointer';
    el.title = 'クリックして画像を変更';
    // ページに既存の file input がある場合はそちらに任せ、CMSは監視のみ
    const parentContainer = el.closest('.greeting-photo, .staff-photo, .voice-avatar, .photo-container');
    const existingInput = parentContainer && parentContainer.querySelector('input[type="file"]');
    if (existingInput) {
      // 既存inputの変更を監視してsavedDataに反映
      const origHandler = existingInput.onchange;
      existingInput.onchange = async function(e) {
        if (origHandler) origHandler.call(this, e);
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await compressImage(file);
        savedData[key] = dataUrl;
        markDirty();
      };
      return;
    }
    el.addEventListener('click', async () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async e => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await compressImage(file);
        el.src = dataUrl;
        savedData[key] = dataUrl;
        markDirty();
        showToast('画像を変更しました');
      };
      input.click();
    });
  }

  // ── フローティングツールバー ──────────────────────
  let floatTb = null;
  function showFloatingToolbar(target) {
    hideFloatingToolbar();
    const type = target.dataset.cmsType || 'text';
    if (type === 'line') return; // 単行は不要

    floatTb = document.createElement('div');
    floatTb.className = 'cms-float-toolbar';
    floatTb.innerHTML = `
      <button onmousedown="event.preventDefault();document.execCommand('bold')" title="太字"><b>B</b></button>
      <button onmousedown="event.preventDefault();document.execCommand('italic')" title="斜体"><i>I</i></button>
      <button onmousedown="event.preventDefault();document.execCommand('underline')" title="下線"><u>U</u></button>
      <div class="cms-ft-sep"></div>
      <button onmousedown="event.preventDefault();insertLink()" title="リンク">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      </button>
    `;

    document.body.appendChild(floatTb);
    positionFloatTb(target);
  }

  function positionFloatTb(target) {
    if (!floatTb) return;
    const rect = target.getBoundingClientRect();
    const tbRect = floatTb.getBoundingClientRect();
    let top = rect.top + window.scrollY - tbRect.height - 8;
    let left = rect.left + window.scrollX;
    if (top < 60) top = rect.bottom + window.scrollY + 8;
    floatTb.style.top = top + 'px';
    floatTb.style.left = Math.max(8, left) + 'px';
  }

  function hideFloatingToolbar() {
    if (floatTb) { floatTb.remove(); floatTb = null; }
  }

  function insertLink() {
    const url = prompt('URLを入力してください:');
    if (url) document.execCommand('createLink', false, url);
  }
  window.insertLink = insertLink;

  // ── ホバーエフェクト ──────────────────────────────
  function addHoverEffects() {
    document.querySelectorAll('[data-cms]').forEach(el => {
      const label = el.dataset.cmsLabel || '編集';
      el.setAttribute('data-cms-label', label);
    });
  }

  // ── 未保存マーク ─────────────────────────────────
  window.cmsMarkDirty = markDirty;
  // 外部（addResident等）から医員名をsavedDataに登録する
  window.cmsSaveResidentName = function(key, name) {
    savedData[key] = name;
  };
  function markDirty() {
    isDirty = true;
    const ind = document.getElementById('cms-dirty-indicator');
    if (ind) ind.style.display = 'flex';
    const saveBtn = document.getElementById('cms-btn-save');
    if (saveBtn) saveBtn.classList.add('has-changes');
  }

  function clearDirty() {
    isDirty = false;
    const ind = document.getElementById('cms-dirty-indicator');
    if (ind) ind.style.display = 'none';
    const saveBtn = document.getElementById('cms-btn-save');
    if (saveBtn) saveBtn.classList.remove('has-changes');
  }

  // ── 保存 ─────────────────────────────────────────
  window.cmsSave = async function() {
    const token = localStorage.getItem(PASSWORD_HASH_KEY);
    const payload = Object.assign({}, savedData, { _token: token });

    try {
      const res = await fetch('cms-save.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();

      if (res.ok && result.success) {
        // バックアップとしてlocalStorageにも保存
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData)); } catch(e) {}
        clearDirty();
        showToast('✅ サーバーに保存しました！', 'success');
      } else if (res.status === 401) {
        showToast('⚠ 認証エラー：cms-save.php の ALLOWED_HASH を確認してください', 'error');
      } else if (res.status === 503) {
        showToast('⚠ cms-save.php の初回設定が未完了です', 'error');
      } else {
        throw new Error(result.error || 'Server error');
      }
    } catch(e) {
      // サーバー保存失敗 → localStorageにフォールバック
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData));
        clearDirty();
        showToast('⚠ サーバー保存失敗。このブラウザにのみ保存しました。', 'error');
      } catch(e2) {
        showToast('⚠ 保存に失敗しました', 'error');
      }
    }
  };

  // ── JSONで書き出し ───────────────────────────────
  window.cmsExport = function() {
    // ページごとのキーを収集してJSONに整形
    const exportData = {
      _exported: new Date().toISOString(),
      _page: location.pathname,
      ...savedData
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const pageName = location.pathname.split('/').pop().replace('.html','') || 'index';
    a.download = `rehab_${pageName}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    showToast('JSONファイルをダウンロードしました');
  };

  // ── プレビュー ────────────────────────────────────
  window.cmsPreview = function() {
    const url = location.href.replace(/[?&]edit=1/, '');
    window.open(url, '_blank');
  };

  // ── 終了（セッションは維持） ──────────────────────
  window.cmsExit = function() {
    if (isDirty) {
      if (!confirm('未保存の変更があります。終了しますか？')) return;
    }
    disableEditMode();
  };

  // ── 編集開始（認証チェック付き） ─────────────────
  window.cmsStartEdit = function() {
    requireAuth().then(ok => {
      if (!ok) return;
      const old = document.getElementById('cms-toggle-btn');
      if (old) old.remove();
      enableEditMode();
    });
  };

  // ═══════════════════════════════════════════════════
  // セキュリティ機能
  // ═══════════════════════════════════════════════════

  // ── SHA-256 ハッシュ ──────────────────────────────
  async function sha256(str) {
    const buf  = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── セッション確認 ────────────────────────────────
  function checkSession() {
    try {
      const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (!raw) return false;
      const { ts } = JSON.parse(raw);
      return (Date.now() - ts) < SESSION_DURATION;
    } catch(e) { return false; }
  }

  // ── セッション保存 ────────────────────────────────
  function saveSession() {
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ ts: Date.now() }));
  }

  // ── セッション削除 ────────────────────────────────
  function clearSessionData() {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
  }

  // ── 認証要求（セッション有効なら即通過） ─────────
  async function requireAuth() {
    if (checkSession()) return true;
    return showAuthDialog();
  }

  // ── ログイン / 初期パスワード設定ダイアログ ───────
  function showAuthDialog() {
    return new Promise(resolve => {
      const existing = document.getElementById('cms-auth-overlay');
      if (existing) existing.remove();

      const hasPassword = !!localStorage.getItem(PASSWORD_HASH_KEY);
      const overlay = document.createElement('div');
      overlay.id = 'cms-auth-overlay';

      if (!hasPassword) {
        // ── 初回セットアップ ──
        overlay.innerHTML = `
          <div class="cms-auth-modal">
            <div class="cms-auth-icon">🔐</div>
            <h2 class="cms-auth-title">初期パスワード設定</h2>
            <p class="cms-auth-desc">初めてご利用です。<br>編集モード用のパスワードを設定してください。</p>
            <div class="cms-auth-field">
              <label>新しいパスワード（6文字以上）</label>
              <input type="password" id="cms-pw-input1" placeholder="パスワードを入力" autocomplete="new-password">
            </div>
            <div class="cms-auth-field">
              <label>パスワード（確認）</label>
              <input type="password" id="cms-pw-input2" placeholder="もう一度入力" autocomplete="new-password">
            </div>
            <div id="cms-auth-error" class="cms-auth-error" style="display:none"></div>
            <button class="cms-auth-btn" id="cms-auth-submit">パスワードを設定して編集開始</button>
            <p class="cms-auth-note">※ パスワードはSHA-256ハッシュ値のみ保存されます</p>
          </div>
        `;
        document.body.appendChild(overlay);

        const input1 = document.getElementById('cms-pw-input1');
        const input2 = document.getElementById('cms-pw-input2');
        const errEl  = document.getElementById('cms-auth-error');
        input1.focus();

        async function handleSetup() {
          const pw1 = input1.value;
          const pw2 = input2.value;
          if (pw1.length < 6) {
            showAuthError(errEl, 'パスワードは6文字以上で入力してください。');
            return;
          }
          if (pw1 !== pw2) {
            showAuthError(errEl, 'パスワードが一致しません。');
            return;
          }
          const hash = await sha256(pw1);
          localStorage.setItem(PASSWORD_HASH_KEY, hash);
          saveSession();
          overlay.remove();
          showToast('🔐 パスワードを設定しました', 'success');
          resolve(true);
        }

        document.getElementById('cms-auth-submit').addEventListener('click', handleSetup);
        [input1, input2].forEach(inp => {
          inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSetup(); });
        });

      } else {
        // ── ログインダイアログ ──
        overlay.innerHTML = `
          <div class="cms-auth-modal">
            <div class="cms-auth-icon">🔒</div>
            <h2 class="cms-auth-title">編集モード ログイン</h2>
            <p class="cms-auth-desc">神戸大学医学部附属病院<br>リハビリテーション科 編集システム</p>
            <div class="cms-auth-field">
              <label>パスワード</label>
              <input type="password" id="cms-pw-input" placeholder="パスワードを入力" autocomplete="current-password">
            </div>
            <div id="cms-auth-error" class="cms-auth-error" style="display:none"></div>
            <button class="cms-auth-btn" id="cms-auth-submit">ログイン</button>
            <div class="cms-auth-cancel">
              <button id="cms-auth-cancel-btn">キャンセル</button>
            </div>
            <p class="cms-auth-note">※ セッションは4時間有効です</p>
          </div>
        `;
        document.body.appendChild(overlay);

        const input = document.getElementById('cms-pw-input');
        const errEl = document.getElementById('cms-auth-error');
        input.focus();

        async function handleLogin() {
          const pw = input.value;
          if (!pw) {
            showAuthError(errEl, 'パスワードを入力してください。');
            return;
          }
          const hash   = await sha256(pw);
          const stored = localStorage.getItem(PASSWORD_HASH_KEY);
          if (hash === stored) {
            saveSession();
            overlay.remove();
            resolve(true);
          } else {
            showAuthError(errEl, 'パスワードが正しくありません。');
            input.value = '';
            input.focus();
          }
        }

        document.getElementById('cms-auth-submit').addEventListener('click', handleLogin);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
        document.getElementById('cms-auth-cancel-btn').addEventListener('click', () => {
          overlay.remove();
          resolve(false);
        });
      }
    });
  }

  // ── 認証エラー表示 ────────────────────────────────
  function showAuthError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
    el.classList.remove('shake');
    void el.offsetWidth; // reflow でアニメーションリセット
    el.classList.add('shake');
  }

  // ── ログアウト（セッション削除 + 編集モード終了） ─
  window.cmsLogout = function() {
    if (isDirty && !confirm('未保存の変更があります。ログアウトしますか？')) return;
    clearSessionData();
    disableEditMode();
    showToast('🔒 ログアウトしました', 'info');
  };

  // ── パスワードのハッシュを取得するユーティリティ ─
  // ブラウザのコンソールで window.cmsGetHash('新しいパスワード') を実行すると
  // SHA-256ハッシュが表示されます（パスワード変更時の確認用）
  window.cmsGetHash = async function(password) {
    const hash = await sha256(password);
    console.log('SHA-256:', hash);
    return hash;
  };

  // ═══════════════════════════════════════════════════
  // トースト通知
  // ═══════════════════════════════════════════════════
  function showToast(msg, type = 'success') {
    const old = document.getElementById('cms-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'cms-toast';
    t.className = `cms-toast cms-toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  // ── スタイル注入 ──────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
/* ===== CMS TOOLBAR ===== */
#cms-toolbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
  background: #0f1923;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  font-family: 'Noto Sans JP', -apple-system, sans-serif;
  box-shadow: 0 2px 20px rgba(0,0,0,0.4);
}
.cms-tb-inner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 1rem; height: 48px; gap: 1rem;
}
.cms-tb-logo {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.82rem; font-weight: 700; color: #00b4d8; white-space: nowrap;
}
.cms-tb-page {
  font-size: 0.76rem; color: rgba(255,255,255,0.4); white-space: nowrap;
  padding-left: 0.8rem; border-left: 1px solid rgba(255,255,255,0.12);
}
.cms-tb-center { flex: 1; display: flex; justify-content: center; }
.cms-tb-hint {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 0.75rem; color: rgba(255,255,255,0.35);
}
.cms-tb-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.cms-dirty {
  display: flex; align-items: center; gap: 0.3rem;
  font-size: 0.73rem; color: #fbbf24; white-space: nowrap;
}
.cms-btn {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.4rem 0.85rem; border-radius: 6px; border: none;
  font-size: 0.78rem; font-weight: 600; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: all 0.15s;
}
.cms-btn-ghost {
  background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.75);
}
.cms-btn-ghost:hover { background: rgba(255,255,255,0.12); color: #fff; }
.cms-btn-primary {
  background: #00b4d8; color: #fff;
}
.cms-btn-primary:hover { background: #009bbf; }
.cms-btn-primary.has-changes { background: #f59e0b; animation: pulse-btn 1.5s ease infinite; }
@keyframes pulse-btn { 0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,0.4)} 50%{box-shadow:0 0 0 6px rgba(245,158,11,0)} }
.cms-btn-logout { background: transparent; color: rgba(255,255,255,0.45); border: 1px solid rgba(255,255,255,0.1); }
.cms-btn-logout:hover { background: rgba(255,180,0,0.1); color: #fbbf24; border-color: rgba(255,180,0,0.3); }
.cms-btn-exit { background: transparent; color: rgba(255,255,255,0.45); border: 1px solid rgba(255,255,255,0.1); }
.cms-btn-exit:hover { background: rgba(255,0,0,0.1); color: #ff6b6b; border-color: rgba(255,0,0,0.2); }

/* ===== BODY OFFSET ===== */
.cms-edit-mode body, body.cms-edit-mode { padding-top: 48px !important; }
.cms-edit-mode header { top: 48px !important; }

/* ===== EDITABLE ELEMENTS ===== */
.cms-edit-mode [data-cms] {
  position: relative;
  outline: 2px dashed transparent;
  outline-offset: 4px;
  border-radius: 3px;
  transition: outline-color 0.2s, background 0.2s;
  cursor: text;
}
.cms-edit-mode [data-cms]:hover {
  outline-color: rgba(0, 180, 216, 0.5);
  background: rgba(0, 180, 216, 0.04);
}
.cms-edit-mode [data-cms]:hover::after {
  content: attr(data-cms-label);
  position: absolute;
  top: -22px; left: 0;
  background: #00b4d8;
  color: #fff;
  font-size: 10px;
  font-family: 'Noto Sans JP', sans-serif;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  white-space: nowrap;
  z-index: 9000;
  pointer-events: none;
  letter-spacing: 0.03em;
}
.cms-edit-mode [data-cms]:focus,
.cms-edit-mode [data-cms].cms-focused {
  outline-color: #00b4d8;
  background: rgba(0, 180, 216, 0.06);
}

/* ===== FLOATING TOOLBAR ===== */
.cms-float-toolbar {
  position: absolute; z-index: 99998;
  background: #1e293b;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 4px 6px;
  display: flex; align-items: center; gap: 2px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}
.cms-float-toolbar button {
  width: 28px; height: 28px; border: none; background: transparent;
  color: rgba(255,255,255,0.8); border-radius: 5px; cursor: pointer;
  font-size: 13px; display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.cms-float-toolbar button:hover { background: rgba(255,255,255,0.1); color: #fff; }
.cms-ft-sep { width: 1px; height: 18px; background: rgba(255,255,255,0.15); margin: 0 3px; }

/* ===== TOGGLE BUTTON ===== */
#cms-toggle-btn {
  position: fixed !important;
  bottom: 2rem !important;
  right: 2rem !important;
  z-index: 2147483647 !important;
  pointer-events: auto !important;
}
#cms-toggle-btn button {
  display: flex !important; align-items: center !important; gap: 0.5rem !important;
  padding: 0.75rem 1.4rem !important; border-radius: 40px !important;
  background: #00b4d8 !important; color: #fff !important;
  border: none !important;
  font-size: 0.88rem !important; font-weight: 700 !important; cursor: pointer !important;
  font-family: 'Noto Sans JP', -apple-system, sans-serif !important;
  box-shadow: 0 4px 24px rgba(0,180,216,0.5), 0 2px 8px rgba(0,0,0,0.2) !important;
  transition: all 0.2s !important;
  white-space: nowrap !important;
}
#cms-toggle-btn button:hover {
  background: #0097b8 !important;
  transform: translateY(-3px) !important;
  box-shadow: 0 8px 32px rgba(0,180,216,0.6) !important;
}

/* ===== TOAST ===== */
.cms-toast {
  position: fixed; bottom: 5rem; left: 50%; transform: translateX(-50%) translateY(20px);
  background: #1e293b; color: #fff;
  padding: 0.7rem 1.4rem; border-radius: 40px;
  font-size: 0.84rem; font-family: 'Noto Sans JP', sans-serif; font-weight: 500;
  box-shadow: 0 8px 28px rgba(0,0,0,0.25);
  z-index: 99999; opacity: 0; transition: all 0.25s; white-space: nowrap;
}
.cms-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.cms-toast-success { border-left: 3px solid #10b981; }
.cms-toast-error   { border-left: 3px solid #ef4444; background: #2d1515; }
.cms-toast-info    { border-left: 3px solid #00b4d8; }

/* ===== ニュース行追加ボタン ===== */
.cms-add-news-btn {
  display: none;
  width: 100%; margin-top: 0.8rem; padding: 0.6rem;
  background: rgba(0,180,216,0.08); border: 2px dashed rgba(0,180,216,0.4);
  color: #00b4d8; border-radius: 8px; cursor: pointer;
  font-size: 0.84rem; font-family: 'Noto Sans JP', sans-serif; font-weight: 600;
  transition: all 0.2s;
}
.cms-add-news-btn:hover { background: rgba(0,180,216,0.15); }
.cms-edit-mode .cms-add-news-btn { display: block; }
.cms-edit-mode .cms-deletable:hover .cms-delete-btn { display: flex; }
.cms-delete-btn {
  display: none; position: absolute; top: 4px; right: 4px; z-index: 100;
  width: 22px; height: 22px; border-radius: 50%;
  background: #ef4444; color: #fff; border: none; cursor: pointer;
  align-items: center; justify-content: center; font-size: 12px;
}
.cms-deletable { position: relative; }

/* ===== AUTH DIALOG ===== */
#cms-auth-overlay {
  position: fixed; inset: 0; z-index: 9999999;
  background: rgba(10, 20, 35, 0.88);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  font-family: 'Noto Sans JP', -apple-system, sans-serif;
  animation: cms-fade-in 0.2s ease;
}
@keyframes cms-fade-in { from { opacity: 0; } to { opacity: 1; } }
.cms-auth-modal {
  background: #fff; border-radius: 14px;
  padding: 2.5rem 2rem; width: 360px; max-width: 92vw;
  box-shadow: 0 24px 64px rgba(0,0,0,0.45);
  animation: cms-slide-up 0.25s ease;
  text-align: center;
}
@keyframes cms-slide-up {
  from { transform: translateY(24px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
.cms-auth-icon { font-size: 2.6rem; margin-bottom: 0.75rem; }
.cms-auth-title {
  font-size: 1.1rem; font-weight: 700; color: #1a2f6e; margin-bottom: 0.5rem;
}
.cms-auth-desc {
  font-size: 0.82rem; color: #888; margin-bottom: 1.5rem; line-height: 1.7;
}
.cms-auth-field { text-align: left; margin-bottom: 1rem; }
.cms-auth-field label {
  display: block; font-size: 0.78rem; font-weight: 600; color: #555; margin-bottom: 0.35rem;
}
.cms-auth-field input {
  width: 100%; box-sizing: border-box;
  padding: 0.65rem 0.9rem; border-radius: 7px;
  border: 1.5px solid #dde8f5; font-size: 0.9rem;
  font-family: inherit; outline: none; transition: border-color 0.2s;
}
.cms-auth-field input:focus { border-color: #1a5fa8; box-shadow: 0 0 0 3px rgba(26,95,168,0.1); }
.cms-auth-error {
  background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5;
  border-radius: 7px; padding: 0.5rem 0.85rem;
  font-size: 0.8rem; margin-bottom: 1rem; text-align: left;
}
@keyframes shake {
  0%,100% { transform: translateX(0); }
  20%,60%  { transform: translateX(-6px); }
  40%,80%  { transform: translateX(6px); }
}
.cms-auth-error.shake { animation: shake 0.35s ease; }
.cms-auth-btn {
  width: 100%; padding: 0.8rem; border: none; border-radius: 8px;
  background: #1a5fa8; color: #fff; font-size: 0.9rem; font-weight: 700;
  cursor: pointer; font-family: inherit; transition: background 0.15s;
  margin-bottom: 0.5rem;
}
.cms-auth-btn:hover { background: #154e92; }
.cms-auth-cancel { margin-top: 0.5rem; }
.cms-auth-cancel button {
  border: none; background: none; color: #aaa; font-size: 0.8rem;
  cursor: pointer; text-decoration: underline; font-family: inherit;
}
.cms-auth-cancel button:hover { color: #666; }
.cms-auth-note {
  font-size: 0.74rem; color: #bbb; margin-top: 1rem; margin-bottom: 0;
}
    `;
    document.head.appendChild(style);
  }

  // 初期化
  injectStyles();
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
