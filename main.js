(function () {
  'use strict';

  // Guard: cegah script jalan dua kali jika inject JS dipanggil ulang
  if (window.__syncTabLoaded) return;
  window.__syncTabLoaded = true;

  // --- Konfigurasi ---
  const CHANNEL_NAME = 'sync-tab-master-channel';
  const TAB_ID = Math.random().toString(36).slice(2);
  const BORN_AT = Date.now();
  const ELECTION_WAIT = 800;
  const HEARTBEAT_INTERVAL = 1000;
  const MASTER_TIMEOUT = 6000;

  // NAIKKAN angka ini setiap kali kamu selesai edit & simpan script.
  // Tab dengan SCRIPT_VERSION lebih kecil akan auto-reload begitu dapat kabar dari tab versi lebih tinggi.
  const SCRIPT_VERSION = 32;

  let isMaster = false;
  let masterId = null;
  let lastMasterHeartbeat = 0;
  let ignoreNextScroll = false;
  let ignoreNextInput = false;
  let syncEnabled = true;
  let globalSyncEnabled = true;
  let consoleVisible = false;
  let ignoreNextNavigate = false;
  let lastUrl = location.href;

  // --- Badge status MASTER/SLAVE ---
  const roleBadge = document.createElement('div');
  roleBadge.id = 'sync-tab-role-badge';
  roleBadge.style.cssText = [
    'position:fixed', 'top:8px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'font:bold 12px sans-serif', 'padding:5px 14px',
    'border-radius:14px', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)',
    'pointer-events:none', 'white-space:nowrap', 'transition:background 0.2s'
  ].join(';');

  function renderRoleBadge() {
    if (isMaster) {
      roleBadge.textContent = '👑 MASTER';
      roleBadge.style.background = '#f1c40f';
      roleBadge.style.color = '#000';
    } else {
      roleBadge.textContent = '🔗 SLAVE';
      roleBadge.style.background = '#3498db';
      roleBadge.style.color = '#fff';
    }
  }
  renderRoleBadge();

  // --- Debug overlay ---
  const debugBox = document.createElement('div');
  debugBox.style.cssText = [
    'position:fixed', 'bottom:8px', 'left:8px', 'z-index:2147483647',
    'background:rgba(0,0,0,0.75)', 'color:#0f0', 'font:11px monospace',
    'padding:6px 8px', 'border-radius:6px', 'max-width:90vw',
    'max-height:140px', 'overflow:auto', 'white-space:pre-wrap',
    'pointer-events:none'
  ].join(';');
  debugBox.id = 'sync-tab-debug-box';

  // --- Tombol toggle sync ---
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'sync-tab-toggle-btn';
  toggleBtn.type = 'button';
  toggleBtn.style.cssText = [
    'position:fixed', 'bottom:104px', 'right:8px', 'z-index:2147483647',
    'font:bold 15px sans-serif', 'width:40px', 'height:40px', 'border-radius:50%',
    'border:none', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)', 'cursor:pointer',
    'line-height:40px', 'text-align:center', 'padding:0'
  ].join(';');

  function renderToggleBtn() {
    if (globalSyncEnabled) {
      toggleBtn.textContent = '🔗';
      toggleBtn.style.background = '#1db954';
      toggleBtn.title = isMaster ? 'SYNC ON — tap untuk OFF semua tab' : 'SYNC ON (dikontrol master)';
    } else {
      toggleBtn.textContent = '⛔';
      toggleBtn.style.background = '#e74c3c';
      toggleBtn.title = isMaster ? 'SYNC OFF — tap untuk ON semua tab' : 'SYNC OFF (dikontrol master)';
    }
    toggleBtn.style.color = '#fff';
    toggleBtn.style.opacity = isMaster ? '1' : '0.55';
    toggleBtn.style.cursor = isMaster ? 'pointer' : 'not-allowed';
  }
  renderToggleBtn();

  toggleBtn.addEventListener('click', () => {
    if (!isMaster) { log('GLOBAL SYNC: hanya MASTER yang bisa ubah.'); return; }
    globalSyncEnabled = !globalSyncEnabled;
    syncEnabled = globalSyncEnabled;
    renderToggleBtn();
    channel.postMessage({ type: 'global-sync-state', enabled: globalSyncEnabled, from: TAB_ID });
    log('GLOBAL SYNC: ' + (globalSyncEnabled ? 'ON' : 'OFF') + ' → broadcast ke semua tab');
  });

  // --- Tombol toggle console ---
  const consoleToggleBtn = document.createElement('button');
  consoleToggleBtn.id = 'sync-tab-console-toggle-btn';
  consoleToggleBtn.type = 'button';
  consoleToggleBtn.style.cssText = [
    'position:fixed', 'bottom:8px', 'left:8px', 'z-index:2147483647',
    'font:bold 13px sans-serif', 'width:32px', 'height:32px', 'border-radius:50%',
    'border:none', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)', 'cursor:pointer',
    'background:#444', 'color:#fff', 'line-height:32px', 'text-align:center', 'padding:0'
  ].join(';');

  function renderConsoleToggleBtn() {
    consoleToggleBtn.textContent = consoleVisible ? '🙈' : '👁';
  }

  function applyConsoleVisibility() {
    debugBox.style.display = consoleVisible ? 'block' : 'none';
    consoleToggleBtn.style.left = '8px';
    consoleToggleBtn.style.bottom = consoleVisible ? '156px' : '8px';
  }

  consoleToggleBtn.addEventListener('click', () => {
    consoleVisible = !consoleVisible;
    scanVisible = !scanVisible;
    renderConsoleToggleBtn();
    applyConsoleVisibility();
    if (typeof applyScanBtnVisibility === 'function') applyScanBtnVisibility();
    if (typeof applyRecBtnVisibility === 'function') applyRecBtnVisibility();
  });
  renderConsoleToggleBtn();

  // =============================================
  // --- ACTION RECORDER ---
  // =============================================
  let recording = false;
  let recordedActions = [];
  let savedSessions = [];
  let recStartTime = 0;
  let recScrollTimeout = null;
  let loadedSessionId = null;

  // --- Panel REC ---
  const recPanel = document.createElement('div');
  recPanel.id = 'sync-tab-rec-panel';
  recPanel.style.cssText = [
    'display:none', 'position:fixed', 'top:56px', 'left:4px', 'right:4px',
    'z-index:2147483647', 'background:rgba(10,10,30,0.96)', 'color:#7ff',
    'font:10px monospace', 'padding:8px', 'border-radius:8px',
    'max-height:70vh', 'overflow:auto', 'white-space:pre-wrap',
    'box-shadow:0 4px 12px rgba(0,0,0,0.7)'
  ].join(';');

  function makeRecToolBtn(label, bg, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.style.cssText = 'background:'+bg+';color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font:bold 10px sans-serif;flex-shrink:0';
    b.addEventListener('click', onClick);
    return b;
  }

  const recToolbar = document.createElement('div');
  recToolbar.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;align-items:center';

  const recStartStopBtn = makeRecToolBtn('\u23fa REKAM',  '#c0392b', () => toggleRecording());
  const recClearBtn     = makeRecToolBtn('\ud83d\uddd1 Hapus',  '#7f8c8d', () => { recordedActions = []; loadedSessionId = null; renderRecPanel(); log('REC: dihapus'); });
  const recPlayBtn      = makeRecToolBtn('\u25b6 Putar',  '#27ae60', () => playRecording());
  const recImportBtn    = makeRecToolBtn('\ud83d\udcc2 Impor',  '#16a085', () => importFromFile());
  const recExportBtn    = makeRecToolBtn('\u2b07 Ekspor', '#d35400', () => openExportPicker());
  const recCloseBtn     = makeRecToolBtn('\u2715 Tutup',  '#555',    () => { recPanel.style.display = 'none'; });

  [recStartStopBtn, recClearBtn, recPlayBtn, recImportBtn, recExportBtn, recCloseBtn].forEach(b => recToolbar.appendChild(b));
  recPanel.appendChild(recToolbar);

  const recStatus = document.createElement('div');
  recStatus.style.cssText = 'color:#f39c12;font:bold 10px monospace;margin-bottom:4px;min-height:14px';
  recPanel.appendChild(recStatus);

  let recLogVisible = false;
  const recLogToggleBtn = makeRecToolBtn('\ud83d\udcdc Log', '#34495e', () => {
    recLogVisible = !recLogVisible;
    applyRecLogVisibility();
  });
  recLogToggleBtn.style.marginBottom = '4px';
  recPanel.appendChild(recLogToggleBtn);

  const recOutput = document.createElement('div');
  recOutput.style.cssText = [
    'max-height:200px', 'overflow:auto', 'border:1px solid #234',
    'border-radius:4px', 'padding:4px', 'margin:4px 0'
  ].join(';');
  recPanel.appendChild(recOutput);

  function applyRecLogVisibility() {
    recOutput.style.display = recLogVisible ? 'block' : 'none';
    recLogToggleBtn.textContent = (recLogVisible ? '\ud83d\udd3c Sembunyikan Log' : '\ud83d\udcdc Lihat Log') + ' (' + recordedActions.length + ')';
  }
  applyRecLogVisibility();

  const recSessionsArea = document.createElement('div');
  recSessionsArea.style.cssText = 'border-top:1px solid #333;margin-top:6px;padding-top:6px';
  recPanel.appendChild(recSessionsArea);

  // Floating REC button
  const recBtn = document.createElement('button');
  recBtn.id = 'sync-tab-rec-btn';
  recBtn.type = 'button';
  recBtn.style.cssText = [
    'position:fixed', 'bottom:8px', 'right:8px', 'z-index:2147483647',
    'font:bold 15px sans-serif', 'width:40px', 'height:40px', 'border-radius:50%',
    'border:none', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)', 'cursor:pointer',
    'background:#c0392b', 'color:#fff', 'line-height:40px', 'text-align:center', 'padding:0'
  ].join(';');

  function renderRecBtn() {
    recBtn.textContent = recording ? '\u23f9' : '\u23fa';
    recBtn.title = recording ? 'Berhenti Merekam' : 'Mulai Merekam';
    recBtn.style.background = recording ? '#e74c3c' : '#c0392b';
    recBtn.style.boxShadow = recording
      ? '0 0 0 3px rgba(231,76,60,0.5), 0 2px 6px rgba(0,0,0,0.4)'
      : '0 2px 6px rgba(0,0,0,0.4)';
  }
  renderRecBtn();

  function setBtnLocked(btn, locked, lockedTitle, unlockedTitle) {
    btn.disabled = locked;
    btn.style.opacity = locked ? '0.4' : '1';
    btn.style.cursor = locked ? 'not-allowed' : 'pointer';
    if (lockedTitle || unlockedTitle) btn.title = locked ? (lockedTitle || '') : (unlockedTitle || '');
  }

  function updatePlayBtnState() {
    const hasActions = recordedActions.length > 0 && loadedSessionId !== null;
    setBtnLocked(recPlayBtn, !hasActions,
      'Muat sebuah sesi dulu untuk membuka kunci Putar',
      'Putar hasil muat Id:' + loadedSessionId);
    setBtnLocked(recClearBtn, recordedActions.length === 0,
      'Tidak ada aksi untuk dihapus', 'Hapus aksi yang sedang terekam');
    setBtnLocked(recImportBtn, savedSessions.length === 0,
      'Belum ada sesi tersimpan', 'Impor file sesi dari device');
  }
  updatePlayBtnState();

  function loadSession(sess) {
    recordedActions = [...sess.actions];
    loadedSessionId = sess.id;
    renderRecPanel();
    log('REC: muat Id:' + sess.id + ' (' + sess.actions.length + ' aksi) \u2192 Putar ter-buka');
  }

  function loadAndPlaySession(sess) {
    loadSession(sess);
    log('REC: putar langsung Id:' + sess.id);
    playRecording();
  }

  function renderRecPanel() {
    recOutput.textContent = '';
    if (recordedActions.length === 0) {
      recOutput.textContent = recording ? '(merekam... lakukan aksi di halaman)\n' : '(belum ada aksi)\n';
    } else {
      recOutput.textContent = recordedActions.map((a, i) => {
        const n = i + 1;
        const t = '+' + a.relMs + 'ms';
        if (a.type === 'click')  return '['+n+'] '+t+' CLICK  '+a.selector.slice(0,55);
        if (a.type === 'input')  return '['+n+'] '+t+' INPUT  '+a.selector.slice(0,35)+' ="'+String(a.value).slice(0,25)+'"';
        if (a.type === 'scroll') return '['+n+'] '+t+' SCROLL '+(a.selector||'window')+' x='+Math.round(a.x)+' y='+Math.round(a.y);
        if (a.type === 'ant-tabs-transform') return '['+n+'] '+t+' TABS '+a.transform;
        return '['+n+'] '+t+' '+a.type;
      }).join('\n') + '\n\n total: ' + recordedActions.length + ' aksi';
    }
    applyRecLogVisibility();
    updatePlayBtnState();
    renderSessions();
  }

  function renderSessions() {
    recSessionsArea.innerHTML = '';
    if (savedSessions.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#888';
      empty.textContent = '(belum ada sesi tersimpan)';
      recSessionsArea.appendChild(empty);
      updatePlayBtnState();
      return;
    }
    const title = document.createElement('div');
    title.style.cssText = 'color:#f39c12;font:bold 10px monospace;margin-bottom:4px';
    title.textContent = '\ud83d\udcc1 SESI TERSIMPAN (' + savedSessions.length + ')';
    recSessionsArea.appendChild(title);
    savedSessions.forEach((sess, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:3px;align-items:center;margin-bottom:3px;flex-wrap:wrap';
      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'color:#7ff;flex:1;min-width:80px;font:9px monospace';
      nameEl.textContent = '['+(idx+1)+'] Id:'+sess.id+' ('+sess.actions.length+' aksi) ('+(sess.recordedAt || '?')+')';
      const playBtn = makeRecToolBtn('\u25b6','#27ae60',() => loadAndPlaySession(sess));
      const expBtn  = makeRecToolBtn('\u2b07','#d35400',() => exportSession(sess));
      const delBtn  = makeRecToolBtn('\u2715','#c0392b',() => { savedSessions.splice(idx,1); renderSessions(); });
      [nameEl,playBtn,expBtn,delBtn].forEach(el => row.appendChild(el));
      recSessionsArea.appendChild(row);
    });
    updatePlayBtnState();
  }

  function setRecToolbarVisible(visible) {
    [recClearBtn, recPlayBtn, recImportBtn, recExportBtn, recCloseBtn].forEach(b => {
      b.style.display = visible ? '' : 'none';
    });
    recSessionsArea.style.display = visible ? '' : 'none';
  }

  function toggleRecording() {
    if (!recording) {
      recording = true;
      recStartTime = Date.now();
      recordedActions = [];
      loadedSessionId = null;
      recStartStopBtn.textContent = '\u23f9 BERHENTI';
      recStartStopBtn.style.background = '#e74c3c';
      recStatus.textContent = '\ud83d\udd34 MEREKAM...';
      setRecToolbarVisible(false);
      debugBox.style.display = 'none';
      recPanel.style.display = 'none';
      renderRecBtn(); renderRecPanel();
      log('REC: \u23fa mulai rekam');
    } else {
      recording = false;
      recStartStopBtn.textContent = '\u23fa REKAM';
      recStartStopBtn.style.background = '#c0392b';
      recStatus.textContent = '\u23f9 Selesai \u2014 ' + recordedActions.length + ' aksi terekam';
      setRecToolbarVisible(true);
      if (consoleVisible) debugBox.style.display = 'block';
      recPanel.style.display = 'block';
      saveSession();
      renderRecBtn(); renderRecPanel();
      log('REC: \u23f9 berhenti, ' + recordedActions.length + ' aksi');
    }
  }

  recBtn.addEventListener('click', () => {
    toggleRecording();
  });

  let sessionIdCounter = 0;
  function genSessionId() {
    sessionIdCounter++;
    return sessionIdCounter;
  }

  function saveSession() {
    if (recordedActions.length === 0) { log('REC: tidak ada aksi'); return; }
    const id = genSessionId();
    const durationSec = Math.round((Date.now() - recStartTime) / 1000);
    const recordedAt = durationSec + 's';
    const name = 'Rec-' + id + '(' + recordedActions.length + ')';
    savedSessions.push({ id, name, recordedAt, actions: [...recordedActions] });
    renderSessions();
    log('REC: sesi "' + name + '" (Id:' + id + ', ' + recordedAt + ') disimpan');
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportSession(sess) {
    downloadJson(sess.id + '.json', { exported: new Date().toISOString(), session: sess });
    log('REC: ekspor sesi id:' + sess.id + ' \u2192 ' + sess.id + '.json');
  }

  function exportAllSessions() {
    if (savedSessions.length === 0) { log('REC: tidak ada sesi untuk diekspor'); return; }
    savedSessions.forEach((sess, i) => {
      setTimeout(() => exportSession(sess), i * 300);
    });
    log('REC: ekspor ' + savedSessions.length + ' sesi');
  }

  function exportSelectedSessions(ids) {
    const selected = savedSessions.filter(s => ids.includes(s.id));
    if (selected.length === 0) { log('REC: tidak ada sesi terpilih'); return; }
    selected.forEach((sess, i) => {
      setTimeout(() => exportSession(sess), i * 300);
    });
    log('REC: ekspor ' + selected.length + ' sesi terpilih (Id: ' + ids.join(', ') + ')');
  }

  // --- Overlay pilihan Ekspor ---
  const exportOverlay = document.createElement('div');
  exportOverlay.id = 'sync-tab-export-overlay';
  exportOverlay.style.cssText = [
    'display:none', 'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
    'z-index:2147483647', 'background:rgba(0,0,0,0.6)',
    'align-items:center', 'justify-content:center'
  ].join(';');
  document.documentElement.appendChild(exportOverlay);

  const exportBox = document.createElement('div');
  exportBox.style.cssText = [
    'background:#10102a', 'color:#7ff', 'font:11px monospace',
    'padding:12px', 'border-radius:10px', 'width:88vw', 'max-width:360px',
    'max-height:78vh', 'overflow:auto', 'box-shadow:0 4px 16px rgba(0,0,0,0.7)'
  ].join(';');
  exportOverlay.appendChild(exportBox);

  function openExportPicker() {
    if (savedSessions.length === 0) { log('REC: tidak ada sesi untuk diekspor'); return; }
    exportBox.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'color:#f39c12;font:bold 12px monospace;margin-bottom:8px';
    title.textContent = '\u2b07 Ekspor Sesi';
    exportBox.appendChild(title);

    const allBtn = makeRecToolBtn('\ud83d\udce6 Ekspor Semua', '#d35400', () => {
      exportAllSessions();
      exportOverlay.style.display = 'none';
    });
    allBtn.style.width = '100%';
    allBtn.style.marginBottom = '8px';
    exportBox.appendChild(allBtn);

    const orLabel = document.createElement('div');
    orLabel.style.cssText = 'color:#888;margin:6px 0;text-align:center';
    orLabel.textContent = '\u2014 atau pilih Id \u2014';
    exportBox.appendChild(orLabel);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px';
    const checkboxes = [];
    savedSessions.forEach(sess => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;color:#7ff;font:10px monospace';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = sess.id;
      checkboxes.push(cb);
      const txt = document.createElement('span');
      txt.textContent = 'Id:' + sess.id + ' (' + sess.actions.length + ' aksi) (' + (sess.recordedAt || '?') + ')';
      row.appendChild(cb); row.appendChild(txt);
      list.appendChild(row);
    });
    exportBox.appendChild(list);

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:6px';
    const exportSelectedBtn = makeRecToolBtn('Ekspor Terpilih', '#8e44ad', () => {
      const ids = checkboxes.filter(cb => cb.checked).map(cb => Number(cb.value));
      if (ids.length === 0) { log('REC: tidak ada Id dipilih'); return; }
      exportSelectedSessions(ids);
      exportOverlay.style.display = 'none';
    });
    exportSelectedBtn.style.flex = '1';
    const cancelBtn = makeRecToolBtn('Batal', '#555', () => { exportOverlay.style.display = 'none'; });
    cancelBtn.style.flex = '1';
    actionRow.appendChild(exportSelectedBtn);
    actionRow.appendChild(cancelBtn);
    exportBox.appendChild(actionRow);

    exportOverlay.style.display = 'flex';
  }

  exportOverlay.addEventListener('click', (e) => {
    if (e.target === exportOverlay) exportOverlay.style.display = 'none';
  });

  function upsertSession(sess) {
    const existingIdx = savedSessions.findIndex(s => s.id === sess.id);
    if (existingIdx !== -1) {
      savedSessions[existingIdx] = sess;
      return 'timpa';
    }
    savedSessions.push(sess);
    return 'baru';
  }

  function importFromFile() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []); if (!files.length) return;
      let pending = files.length;
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data)) {
              const id = genSessionId();
              upsertSession({ id, name: file.name.replace('.json',''), recordedAt: '-', actions: data });
              log('REC: impor ' + data.length + ' aksi dari ' + file.name + ' \u2192 Id baru:' + id);
            } else if (data.session) {
              const s = data.session;
              const id = (typeof s.id === 'number') ? s.id : genSessionId();
              if (id > sessionIdCounter) sessionIdCounter = id;
              const result = upsertSession({ id, name: s.name || file.name.replace('.json',''), recordedAt: s.recordedAt || '-', actions: s.actions || [] });
              log('REC: impor sesi dari ' + file.name + ' \u2192 Id:' + id + ' (' + (result === 'timpa' ? 'ditimpa' : 'baru') + ')');
            } else if (data.sessions) {
              data.sessions.forEach(s => {
                const id = (typeof s.id === 'number') ? s.id : genSessionId();
                if (id > sessionIdCounter) sessionIdCounter = id;
                upsertSession({ id, name: s.name, recordedAt: s.recordedAt || '-', actions: s.actions });
              });
              log('REC: impor ' + data.sessions.length + ' sesi dari ' + file.name);
            }
          } catch(err) { log('REC: impor gagal: ' + err.message); }
          pending--;
          if (pending === 0) { renderSessions(); recPanel.style.display = 'block'; }
        };
        reader.readAsText(file);
      });
    });
    input.click();
  }

  function recPush(action) {
    if (!recording) return;
    if (action.type === 'click' && action.selector && (
      action.selector.includes('sync-tab-') || action.selector.includes('rd-scan-')
    )) return;
    action.relMs = Date.now() - recStartTime;
    recordedActions.push(action);
    renderRecPanel();
  }

  function playRecording() {
    if (recordedActions.length === 0) { log('REC: tidak ada aksi untuk diputar'); return; }
    log('REC: putar ' + recordedActions.length + ' aksi...');
    setRecToolbarVisible(false);
    recStatus.textContent = '\u25b6 Memutar...';
    recPanel.style.display = 'none';
    let i = 0;
    function next() {
      if (i >= recordedActions.length) {
        log('REC: putar selesai');
        recStatus.textContent = '\u23f9 Selesai \u2014 ' + recordedActions.length + ' aksi terekam';
        setRecToolbarVisible(true);
        recPanel.style.display = 'block';
        return;
      }
      const a = recordedActions[i];
      const delay = i === 0 ? 0 : (a.relMs - recordedActions[i-1].relMs);
      i++;
      setTimeout(() => {
        try {
          if (a.type === 'scroll') {
            if (!a.selector) {
              window.scrollTo({ left: a.x, top: a.y, behavior: 'auto' });
            } else {
              const el = findElement(a.selector);
              if (el) { el.scrollLeft = a.x; el.scrollTop = a.y; }
            }
          } else if (a.type === 'click') {
            let el = findElement(a.selector);
            if (el) {
              const inner = el.querySelector('input[type="checkbox"]') || el.querySelector('input[type="radio"]');
              if (inner) el = inner;
              const rect = el.getBoundingClientRect();
              const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
              const evOpts = { bubbles:true, cancelable:true, clientX:cx, clientY:cy, view:window };
              ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(ev => {
                el.dispatchEvent(new (ev.startsWith('pointer')?PointerEvent:MouseEvent)(ev, evOpts));
              });
            }
          } else if (a.type === 'input') {
            const el = findElement(a.selector);
            if (el) {
              if (a.isContentEditable) { el.innerHTML = a.value; }
              else { el.value = a.value; }
              el.dispatchEvent(new Event('input', { bubbles:true }));
              el.dispatchEvent(new Event('change', { bubbles:true }));
            }
          } else if (a.type === 'ant-tabs-transform') {
            const el = findElement(a.selector);
            if (el) { el.style.transform = a.transform; el.style.transition = 'none'; }
          }
        } catch(e) { log('REC play error: ' + e.message); }
        next();
      }, Math.max(0, delay));
    }
    next();
  }

  // --- Tombol SCAN ---
  const scanBtn = document.createElement('button');
  scanBtn.id = 'sync-tab-scan-btn';
  scanBtn.type = 'button';
  scanBtn.textContent = '🔍';
  scanBtn.title = 'Scan DOM';
  scanBtn.style.cssText = [
    'position:fixed', 'bottom:56px', 'right:8px', 'z-index:2147483647',
    'font:bold 13px sans-serif', 'width:40px', 'height:40px', 'border-radius:50%',
    'border:none', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)', 'cursor:pointer',
    'background:#e67e22', 'color:#fff', 'line-height:40px', 'text-align:center', 'padding:0'
  ].join(';');

  // --- Panel SCAN ---
  const scanPanel = document.createElement('div');
  scanPanel.id = 'sync-tab-scan-panel';
  scanPanel.style.cssText = [
    'display:none', 'position:fixed', 'top:60px', 'left:4px', 'right:4px',
    'z-index:2147483647', 'background:rgba(0,0,0,0.92)', 'color:#0f0',
    'font:10px monospace', 'padding:8px', 'border-radius:8px',
    'max-height:65vh', 'overflow:auto', 'white-space:pre-wrap',
    'box-shadow:0 4px 12px rgba(0,0,0,0.6)'
  ].join(';');

  const scanCloseBtn = document.createElement('button');
  scanCloseBtn.type = 'button';
  scanCloseBtn.textContent = '✕ Tutup';
  scanCloseBtn.style.cssText = [
    'display:block', 'margin-bottom:6px', 'background:#c0392b', 'color:#fff',
    'border:none', 'border-radius:6px', 'padding:4px 10px', 'cursor:pointer',
    'font:bold 11px sans-serif'
  ].join(';');
  scanCloseBtn.addEventListener('click', () => { scanPanel.style.display = 'none'; });
  scanPanel.appendChild(scanCloseBtn);

  const scanOutput = document.createElement('div');
  scanPanel.appendChild(scanOutput);

  function runScan() {
    scanOutput.textContent = '';
    scanPanel.style.display = 'block';
    function slog(s) { scanOutput.textContent += s + '\n'; }

    slog('=== SCAN ' + new Date().toLocaleTimeString() + ' | ' + location.pathname + ' ===\n');
    slog('WINDOW: scrollX=' + Math.round(window.scrollX) + ' scrollY=' + Math.round(window.scrollY));

    slog('\n--- SCROLLABLE ---');
    let n = 0;
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (OWN_IDS.has(el.id)) return;
      const cs = window.getComputedStyle(el);
      const hs = (cs.overflowX==='auto'||cs.overflowX==='scroll') && el.scrollWidth > el.clientWidth + 1;
      const vs = (cs.overflowY==='auto'||cs.overflowY==='scroll') && el.scrollHeight > el.clientHeight + 1;
      if (!hs && !vs) return;
      n++;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#'+el.id : '';
      const cls = (typeof el.className==='string') ? el.className.trim().split(/\s+/).slice(0,4).join(' ') : '';
      slog('['+n+'] <'+tag+id+'> "'+cls.slice(0,50)+'"');
      slog('  oX='+cs.overflowX+' oY='+cs.overflowY);
      slog('  sL='+Math.round(el.scrollLeft)+' sT='+Math.round(el.scrollTop)+' sW='+el.scrollWidth+' sH='+el.scrollHeight+' cW='+el.clientWidth+' cH='+el.clientHeight);
      if (el.style.transform) slog('  transform='+el.style.transform);
    });
    if (n===0) slog('(tidak ada)');

    slog('\n--- INLINE TRANSFORM ---');
    let t = 0;
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (!el.style.transform || OWN_IDS.has(el.id)) return;
      t++;
      const cls = (typeof el.className==='string') ? el.className.trim().split(/\s+/).slice(0,3).join('.') : '';
      slog('['+t+'] '+el.tagName.toLowerCase()+(cls?'.'+cls.slice(0,40):'')+' \u2192 '+el.style.transform);
    });
    if (t===0) slog('(tidak ada)');

    slog('\n--- ANT DESIGN ---');
    ['.ant-tabs-nav-wrap','.ant-tabs-nav-list','.ant-tabs-ink-bar',
     '.ant-table-body','.ant-layout-content','.ant-pro-page-container'].forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) { slog(sel+': -'); return; }
      const cs = window.getComputedStyle(el);
      slog(sel+': sL='+Math.round(el.scrollLeft)+' sT='+Math.round(el.scrollTop)+' sW='+el.scrollWidth+' sH='+el.scrollHeight+' oX='+cs.overflowX+' oY='+cs.overflowY+(el.style.transform?' tr='+el.style.transform:''));
    });

    slog('\n=== SELESAI ===');
    scanPanel.scrollTop = 0;
  }

  scanBtn.addEventListener('click', () => {
    if (scanPanel.style.display !== 'none') {
      scanPanel.style.display = 'none';
    } else {
      runScan();
    }
  });

  let scanVisible = true;
  function applyScanBtnVisibility() {
    scanBtn.style.display = scanVisible ? 'block' : 'none';
    if (!scanVisible) scanPanel.style.display = 'none';
  }

  function applyRecBtnVisibility() {
    recBtn.style.display = 'block';
  }

  // ID elemen UI milik script sendiri
  const OWN_IDS = new Set([
    'sync-tab-debug-box', 'sync-tab-toggle-btn', 'sync-tab-role-badge',
    'sync-tab-console-toggle-btn', 'sync-tab-scan-btn', 'sync-tab-scan-panel',
    'sync-tab-rec-btn', 'sync-tab-rec-panel', 'sync-tab-export-overlay',
    'rd-scan-btn', 'rd-scan-box'
  ]);

  function attachUI() {
    const root = document.body || document.documentElement;
    root.appendChild(roleBadge);
    root.appendChild(debugBox);
    root.appendChild(toggleBtn);
    root.appendChild(consoleToggleBtn);
    root.appendChild(recBtn);
    root.appendChild(recPanel);
    root.appendChild(scanBtn);
    root.appendChild(scanPanel);
    applyConsoleVisibility();
    applyScanBtnVisibility();
    applyRecBtnVisibility();
  }
  if (document.body) attachUI();
  else document.addEventListener('DOMContentLoaded', attachUI);

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    debugBox.textContent += '[' + time + '] ' + msg + '\n';
    debugBox.scrollTop = debugBox.scrollHeight;
    console.log('[SyncTab]', msg);
  }

  window.addEventListener('error', (e) => {
    log('ERROR: ' + e.message);
  });

  let channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME + '-' + location.host);
    log('BroadcastChannel OK, host=' + location.host + ' tabId=' + TAB_ID);
  } catch (e) {
    log('BroadcastChannel GAGAL: ' + e.message);
    return;
  }

  // --- Auto-reload jika ada tab versi lebih baru ---
  let reloadTriggered = false;
  function checkAndReloadIfOutdated(remoteVersion, fromId) {
    if (reloadTriggered) return;
    if (remoteVersion > SCRIPT_VERSION) {
      reloadTriggered = true;
      log('VERSION: tab ' + fromId + ' versi ' + remoteVersion + ' > versi saya ' + SCRIPT_VERSION + ' \u2192 reload otomatis...');
      setTimeout(() => location.reload(), 150);
    }
  }
  channel.postMessage({ type: 'hello-version', from: TAB_ID, version: SCRIPT_VERSION });
  log('VERSION: kirim hello-version v' + SCRIPT_VERSION);

  // --- Election master ---
  const knownTabs = new Map();
  let electionDone = false;

  function claimMaster(reason) {
    if (isMaster) return;
    isMaster = true;
    masterId = TAB_ID;
    renderRoleBadge();
    renderToggleBtn();
    log('STATUS: tab ini jadi MASTER (' + reason + ')');
    channel.postMessage({ type: 'i-am-master', from: TAB_ID, bornAt: BORN_AT });
    channel.postMessage({ type: 'global-sync-state', enabled: globalSyncEnabled, from: TAB_ID });
  }

  function becomeSlaveOf(id) {
    if (masterId === id && !isMaster) return;
    isMaster = false;
    masterId = id;
    lastMasterHeartbeat = Date.now();
    renderRoleBadge();
    renderToggleBtn();
    log('STATUS: tab ini jadi SLAVE (master=' + id + ')');
  }

  function runElection() {
    knownTabs.set(TAB_ID, BORN_AT);
    log('ELECTION: mulai, kirim hello (tabId=' + TAB_ID + ' bornAt=' + BORN_AT + ')');
    channel.postMessage({ type: 'hello', from: TAB_ID, bornAt: BORN_AT });
    setTimeout(() => {
      if (electionDone || masterId) {
        log('ELECTION: dibatalkan (electionDone=' + electionDone + ' masterId=' + masterId + ')');
        return;
      }
      electionDone = true;
      let oldest = TAB_ID;
      let oldestBorn = BORN_AT;
      for (const [id, born] of knownTabs.entries()) {
        if (born < oldestBorn) { oldest = id; oldestBorn = born; }
      }
      log('ELECTION: selesai tunggu, knownTabs=' + knownTabs.size + ' oldest=' + oldest);
      if (oldest === TAB_ID) {
        claimMaster('election, tertua di antara ' + knownTabs.size + ' tab');
      } else {
        becomeSlaveOf(oldest);
      }
    }, ELECTION_WAIT);
  }

  // --- Selector utils ---
  function isSelectorUnique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; }
  }

  function isHashClass(c) {
    return /^(css-|acss-|sc-|_|go|r-)[a-z0-9]+$/i.test(c) || /^[a-z]{1,3}[0-9a-z]{5,}$/i.test(c);
  }

  function stableClasses(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className.trim().split(/\s+/).filter(c => c && !isHashClass(c));
  }

  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (isSelectorUnique(sel)) return sel;
    }
    const stableAttrs = ['data-testid', 'data-test', 'data-id', 'data-qa', 'name', 'aria-label', 'data-node-key'];
    for (const attr of stableAttrs) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (val) {
        const sel = el.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(val) + '"]';
        if (isSelectorUnique(sel)) return sel;
      }
    }
    if (['BUTTON','A','SPAN','LI'].includes(el.tagName)) {
      const txt = (el.innerText || '').trim().slice(0, 30);
      if (txt && txt.length > 1 && txt.length < 30) {
        const matches = Array.from(document.querySelectorAll(el.tagName.toLowerCase()))
          .filter(e => (e.innerText || '').trim().slice(0, 30) === txt);
        if (matches.length === 1) return el.tagName.toLowerCase() + '[data-sync-text="' + CSS.escape(txt) + '"]';
      }
    }
    const semCls = stableClasses(el);
    if (semCls.length) {
      const sel = el.tagName.toLowerCase() + semCls.map(c => '.' + CSS.escape(c)).join('');
      if (isSelectorUnique(sel)) return sel;
    }
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { path.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const cls = stableClasses(node).slice(0, 2);
      if (cls.length) part += cls.map(c => '.' + CSS.escape(c)).join('');
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      path.unshift(part);
      node = node.parentElement;
    }
    return path.join(' > ');
  }

  function findElement(selector) {
    try {
      const textMatch = selector.match(/^([a-z]+)\[data-sync-text="(.+)"\]$/);
      if (textMatch) {
        const tag = textMatch[1];
        const txt = textMatch[2].replace(/\\(.)/g, '$1');
        return Array.from(document.querySelectorAll(tag))
          .find(e => (e.innerText || '').trim().slice(0, 30) === txt) || null;
      }
      return document.querySelector(selector);
    } catch (e) { return null; }
  }

  // --- MASTER: broadcast aksi ---
  function broadcast(type, payload) {
    channel.postMessage({ type, payload, from: TAB_ID });
    log('KIRIM ' + type + ': ' + JSON.stringify(payload).slice(0, 60));
    recPush({ type, ...payload });
  }

  // --- Scroll ---
  let scrollTimeout = null;
  const touchStartSnapshots = new WeakMap();

  function getAllScrollables() {
    return Array.from(document.querySelectorAll('*')).filter(el =>
      el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight
    );
  }

  document.addEventListener('touchstart', () => {
    getAllScrollables().forEach(el => {
      touchStartSnapshots.set(el, { x: el.scrollLeft, y: el.scrollTop });
    });
  }, { passive: true, capture: true });

  document.addEventListener('touchend', () => {
    if (!isMaster || !syncEnabled) return;
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      getAllScrollables().forEach(el => {
        if (isOwnElement(el)) return;
        const snap = touchStartSnapshots.get(el);
        if (!snap) return;
        if (Math.abs(el.scrollLeft - snap.x) > 2 || Math.abs(el.scrollTop - snap.y) > 2) {
          const selector = getSelector(el);
          if (selector) broadcast('scroll', { selector, x: el.scrollLeft, y: el.scrollTop });
        }
      });
      if (Math.abs(window.scrollX - (touchStartSnapshots.get(window) || {x:window.scrollX}).x) > 2 ||
          Math.abs(window.scrollY - (touchStartSnapshots.get(window) || {y:window.scrollY}).y) > 2) {
        broadcast('scroll', { selector: null, x: window.scrollX, y: window.scrollY });
      }
    }, 80);
  }, { passive: true, capture: true });

  function isOwnElement(el) {
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
      if (node.id && OWN_IDS.has(node.id)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function onScrollEvent(e) {
    if (!isMaster || !syncEnabled || ignoreNextScroll) { ignoreNextScroll = false; return; }
    const target = e.target;
    if (isOwnElement(target)) return;
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      if (target === document || target === document.documentElement || target === document.body) {
        broadcast('scroll', { selector: null, x: window.scrollX, y: window.scrollY });
      } else {
        const selector = getSelector(target);
        if (selector) broadcast('scroll', { selector, x: target.scrollLeft, y: target.scrollTop });
      }
    }, 50);
  }
  window.addEventListener('scroll', onScrollEvent, { capture: true, passive: true });

  // --- Ant Design tabs transform ---
  let antTabsObserver = null;
  let antTabsLastTransform = '';

  function watchAntTabsTransform() {
    const navList = document.querySelector('.ant-tabs-nav-list');
    if (!navList || antTabsObserver) return;
    antTabsObserver = new MutationObserver(() => {
      if (!isMaster || !syncEnabled) return;
      const t = navList.style.transform;
      if (t && t !== antTabsLastTransform) {
        antTabsLastTransform = t;
        broadcast('ant-tabs-transform', { selector: '.ant-tabs-nav-list', transform: t });
        log('ANT-TABS: transform=' + t);
      }
    });
    antTabsObserver.observe(navList, { attributes: true, attributeFilter: ['style'] });
    log('ANT-TABS: observer aktif di .ant-tabs-nav-list');
  }
  watchAntTabsTransform();
  setInterval(watchAntTabsTransform, 2000);

  // --- Klik ---
  document.addEventListener('click', (e) => {
    if (!isMaster || !syncEnabled) return;
    const selector = getSelector(e.target);
    if (selector) broadcast('click', { selector });
  }, true);

  // --- Input ---
  document.addEventListener('input', (e) => {
    if (!isMaster || !syncEnabled || ignoreNextInput) return;
    const el = e.target;
    const selector = getSelector(el);
    if (!selector) return;
    const value = el.isContentEditable ? el.innerHTML : el.value;
    broadcast('input', { selector, value, isContentEditable: !!el.isContentEditable });
  }, true);

  // --- SLAVE: terima & terapkan aksi ---
  channel.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'hello-version') { checkAndReloadIfOutdated(msg.version, msg.from); return; }

    if (msg.type === 'global-sync-state') {
      if (!isMaster) {
        globalSyncEnabled = msg.enabled;
        syncEnabled = msg.enabled;
        renderToggleBtn();
        log('GLOBAL SYNC: terima dari master \u2192 ' + (syncEnabled ? 'ON' : 'OFF'));
      }
      return;
    }

    if (msg.type === 'hello') {
      log('TERIMA hello: from=' + msg.from + ' bornAt=' + msg.bornAt);
      knownTabs.set(msg.from, msg.bornAt);
      if (isMaster) channel.postMessage({ type: 'i-am-master', from: TAB_ID, bornAt: BORN_AT });
      return;
    }

    if (msg.type === 'i-am-master') {
      log('TERIMA i-am-master: from=' + msg.from + ' bornAt=' + msg.bornAt);
      knownTabs.set(msg.from, msg.bornAt);
      if (isMaster && msg.from !== TAB_ID) {
        if (msg.bornAt < BORN_AT) {
          log('KONFLIK MASTER: tab ' + msg.from + ' lebih tua, saya mengalah jadi SLAVE');
          becomeSlaveOf(msg.from);
        } else {
          log('KONFLIK MASTER: saya lebih tua, tetap MASTER');
          channel.postMessage({ type: 'i-am-master', from: TAB_ID, bornAt: BORN_AT });
        }
        return;
      }
      electionDone = true;
      if (msg.from !== TAB_ID) becomeSlaveOf(msg.from);
      return;
    }

    if (msg.type === 'navigate') {
      if (isMaster) return;
      if (!syncEnabled) { log('LEWATI navigate (sync OFF)'); return; }
      if (msg.url === location.href) return;
      log('TERIMA navigate: ' + msg.url.slice(0, 70) + ' \u2192 pindah...');
      ignoreNextNavigate = true;
      location.href = msg.url;
      return;
    }

    if (msg.type === 'heartbeat') {
      if (msg.from === masterId) lastMasterHeartbeat = Date.now();
      return;
    }

    if (msg.type === 'bye' && msg.from === masterId) {
      log('STATUS: master pergi, election ulang');
      masterId = null;
      electionDone = false;
      runElection();
      return;
    }

    if (isMaster) {
      if (msg.type === 'scroll' || msg.type === 'click' || msg.type === 'input') {
        log('ABAIKAN ' + msg.type + ' dari ' + msg.from + ' (saya juga MASTER)');
      }
      return;
    }

    const { type, payload } = msg;
    if (type === 'scroll' || type === 'click' || type === 'input') {
      if (!syncEnabled) { log('LEWATI ' + type + ' (sync OFF)'); return; }
      log('TERIMA ' + type + ': ' + JSON.stringify(payload).slice(0, 60));
    }

    if (type === 'scroll') {
      ignoreNextScroll = true;
      if (!payload.selector) {
        window.scrollTo({ left: payload.x, top: payload.y, behavior: 'auto' });
      } else {
        const el = findElement(payload.selector);
        if (el) {
          el.scrollLeft = payload.x;
          el.scrollTop = payload.y;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
        } else { log('WARN: scroll container tidak ketemu: ' + payload.selector.slice(0, 60)); }
      }
    }

    if (type === 'ant-tabs-transform') {
      const el = findElement(payload.selector);
      if (el) {
        el.style.transform = payload.transform;
        el.style.transition = 'none';
        log('ANT-TABS: apply transform=' + payload.transform);
      } else { log('WARN: .ant-tabs-nav-list tidak ketemu'); }
    }

    if (type === 'click') {
      let el = findElement(payload.selector);
      if (el) {
        const inner = el.querySelector('input[type="checkbox"]') || el.querySelector('input[type="radio"]');
        if (inner) { el = inner; log('KLIK: redirect ke inner input'); }
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const evOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
        ['pointerover','pointerenter','mouseover','mouseenter',
         'pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click'].forEach(evName => {
          const Ctor = evName.startsWith('pointer') ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(evName, evOpts));
        });
        if (el.type === 'checkbox' || el.type === 'radio') {
          const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
          if (niv && niv.set) niv.set.call(el, !el.checked);
          else el.checked = !el.checked;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        log('KLIK: dispatch ke ' + payload.selector.slice(0, 60));
      } else { log('WARN: elemen klik tidak ketemu: ' + payload.selector.slice(0, 70)); }
    }

    if (type === 'input') {
      const el = findElement(payload.selector);
      if (el) {
        ignoreNextInput = true;
        if (payload.isContentEditable) { el.innerHTML = payload.value; }
        else { el.value = payload.value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => (ignoreNextInput = false), 50);
      } else { log('WARN: elemen input tidak ketemu: ' + payload.selector.slice(0, 70)); }
    }
  };

  runElection();

  setInterval(() => {
    if (isMaster) {
      channel.postMessage({ type: 'heartbeat', from: TAB_ID });
    } else if (masterId && Date.now() - lastMasterHeartbeat > MASTER_TIMEOUT) {
      log('STATUS: master timeout, election ulang');
      masterId = null;
      electionDone = false;
      runElection();
    }
  }, HEARTBEAT_INTERVAL);

  function isBackForwardNavigation() {
    try {
      const entries = performance.getEntriesByType('navigation');
      if (entries.length && entries[0].type) return entries[0].type === 'back_forward';
      if (performance.navigation) return performance.navigation.type === 2;
    } catch (e) {}
    return false;
  }

  if (isBackForwardNavigation()) {
    log('NAVIGASI: halaman dimuat via back/forward');
    setTimeout(() => {
      if (isMaster && syncEnabled) {
        channel.postMessage({ type: 'navigate', url: location.href, from: TAB_ID });
        log('KIRIM navigate: ' + location.href.slice(0, 70));
      }
    }, ELECTION_WAIT + 100);
  }

  window.addEventListener('popstate', () => {
    if (ignoreNextNavigate) { ignoreNextNavigate = false; lastUrl = location.href; return; }
    if (isMaster && syncEnabled && location.href !== lastUrl) {
      channel.postMessage({ type: 'navigate', url: location.href, from: TAB_ID });
      log('KIRIM navigate (popstate): ' + location.href.slice(0, 70));
    }
    lastUrl = location.href;
  });

  window.addEventListener('beforeunload', () => {
    if (isMaster) channel.postMessage({ type: 'bye', from: TAB_ID });
  });

})();
