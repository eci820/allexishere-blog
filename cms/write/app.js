/* 로컬 글쓰기 편집기 (dev 전용). Toast UI Editor 3.2.2 기반.
   서버 API: /write/api/{posts,save,upload,publish}. 운영 사이트와 완전 분리. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var editor = null;
  // 현재 작성 상태
  var S = null;

  // ---------- 유틸 ----------
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(msg) {
    var t = el('<div class="toast">' + esc(msg) + '</div>'); document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }
  function api(path, body) {
    return fetch('/write/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }
  function slugify(title) {
    return (title || '').trim()
      .replace(/[\/\\:*?"<>|#%\[\]{}()]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ---------- 목록 화면 ----------
  function showList() {
    S = null; if (editor) { try { editor.destroy(); } catch (e) {} editor = null; }
    app.innerHTML = '';
    app.appendChild(el(
      '<div class="topbar"><h1>✍ 로컬 글쓰기<span class="sub">allexishere.com · 개발용(로컬 전용)</span></h1>' +
      '<button class="primary" id="newBtn">+ 새 글쓰기</button></div>'
    ));
    var wrap = el('<div class="wrap"></div>');
    wrap.appendChild(el(
      '<div class="filters"><select id="filter"><option value="all">전체</option>' +
      '<option value="draft">임시</option><option value="pub">발행</option></select>' +
      '<input type="text" id="q" placeholder="제목 검색"></div>'
    ));
    var listBox = el('<div id="listBox">불러오는 중…</div>');
    wrap.appendChild(listBox);
    app.appendChild(wrap);
    document.getElementById('newBtn').onclick = function () { openEditor(null); };

    api('posts').then(function (res) {
      var posts = (res && res.posts) || [];
      function render() {
        var f = document.getElementById('filter').value;
        var q = (document.getElementById('q').value || '').toLowerCase();
        listBox.innerHTML = '';
        var shown = posts.filter(function (p) {
          if (f === 'draft' && !p.draft) return false;
          if (f === 'pub' && p.draft) return false;
          if (q && (p.title || '').toLowerCase().indexOf(q) === -1) return false;
          return true;
        });
        if (!shown.length) { listBox.appendChild(el('<div class="hint">글이 없습니다.</div>')); return; }
        shown.forEach(function (p) {
          var badge = p.draft ? '<span class="badge draft">임시</span>' : '<span class="badge pub">발행</span>';
          var ro = p.readOnly ? '<span class="badge ro">읽기전용</span>' : '';
          var btn = p.readOnly
            ? '<button class="ghost" data-ro="' + esc(p.slug) + '">보기</button>'
            : '<button data-open="' + esc(p.slug) + '">열기</button>';
          var row = el('<div class="post-row">' + badge + ro +
            '<span class="title">' + esc(p.title || '(제목 없음)') + '</span>' +
            '<span class="date">' + esc((p.pubDate || '').slice(0, 10)) + '</span>' + btn + '</div>');
          listBox.appendChild(row);
        });
        listBox.querySelectorAll('[data-open]').forEach(function (b) {
          b.onclick = function () { openEditor(b.getAttribute('data-open')); };
        });
        listBox.querySelectorAll('[data-ro]').forEach(function (b) {
          b.onclick = function () { window.open('/entry/' + encodeURIComponent(b.getAttribute('data-ro')), '_blank'); };
        });
      }
      document.getElementById('filter').onchange = render;
      document.getElementById('q').oninput = render;
      render();
    });
  }

  // ---------- 작성 화면 ----------
  function openEditor(slug) {
    if (slug) {
      api('load', { slug: slug }).then(function (res) {
        if (!res.ok) { toast('불러오기 실패: ' + (res.error || '')); return; }
        startEditor(res.post);
      });
    } else {
      startEditor({ isNew: true, title: '', slug: '', description: '', tags: [], body: '', draft: true, diskSlug: null, published: false });
    }
  }

  function startEditor(post) {
    S = {
      isNew: !!post.isNew,
      title: post.title || '',
      slug: post.slug || '',
      description: post.description || '',
      tags: (post.tags || []).slice(),
      body: post.body || '',
      draft: post.draft !== false,
      published: !post.draft,          // 발행됨(=draft false)이면 주소 잠금
      diskSlug: post.slug || null,     // 디스크에 저장된 폴더명(없으면 null)
      slugAuto: !!post.isNew,          // 새 글은 제목→슬러그 자동(최초 1회)
      slugFrozen: !post.isNew,         // 기존 글은 슬러그 고정
    };
    app.innerHTML = '';
    app.appendChild(el('<div class="topbar"><h1><button class="ghost" id="backBtn">← 목록</button></h1></div>'));
    var wrap = el('<div class="wrap"></div>');

    var slugDisabled = S.published; // 발행글은 주소 필드 잠금
    var meta = el(
      '<div class="meta">' +
      '<div class="field"><label>제목</label><input type="text" id="f_title" placeholder="글 제목"></div>' +
      '<div class="field"><label>주소(슬러그)</label><div class="slugline"><span class="prefix">/entry/</span>' +
      '<input type="text" id="f_slug"' + (slugDisabled ? ' disabled' : '') + '></div>' +
      '<div class="hint" id="slugHint"></div></div>' +
      '<div class="field"><label>태그</label><div class="tags" id="f_tags"></div></div>' +
      '<div class="field"><label>설명(요약)</label><input type="text" id="f_desc" placeholder="검색결과·목록에 보일 요약(비우면 본문 앞부분)"></div>' +
      '</div>'
    );
    wrap.appendChild(meta);
    wrap.appendChild(el('<div class="custombar"><button id="galleryBtn">🖼 갤러리(여러 장)</button><button id="tipBtn">💡 팁박스</button></div>'));
    wrap.appendChild(el('<div id="toast-editor"></div>'));
    app.appendChild(wrap);

    var footer = el('<div class="footer"><span class="hint" id="fhint"></span>' +
      '<button id="saveBtn">임시저장</button>' +
      '<button id="previewBtn" disabled>미리보기</button>' +
      '<button class="primary" id="pubBtn">발행하기</button></div>');
    app.appendChild(footer);

    // 필드 채우기
    var fTitle = document.getElementById('f_title');
    var fSlug = document.getElementById('f_slug');
    var fDesc = document.getElementById('f_desc');
    fTitle.value = S.title; fSlug.value = S.slug; fDesc.value = S.description;
    renderTags();
    updateSlugHint();
    if (S.diskSlug) document.getElementById('previewBtn').disabled = false;

    // 제목 → 슬러그 자동(최초 1회, 저장/수동수정 전까지)
    fTitle.oninput = function () {
      S.title = fTitle.value;
      if (S.slugAuto && !S.slugFrozen && !S.diskSlug) { S.slug = slugify(S.title); fSlug.value = S.slug; updateSlugHint(); }
    };
    fSlug.oninput = function () { S.slug = slugify(fSlug.value); if (fSlug.value !== S.slug) fSlug.value = S.slug; S.slugAuto = false; updateSlugHint(); };
    fDesc.oninput = function () { S.description = fDesc.value; };

    document.getElementById('backBtn').onclick = function () {
      if (confirm('목록으로 돌아갈까요? 저장 안 한 변경은 사라집니다.')) showList();
    };

    // Toast UI Editor
    editor = new toastui.Editor({
      el: document.getElementById('toast-editor'),
      height: '520px',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      language: 'ko-KR',
      initialValue: S.body,
      usageStatistics: false,
      hooks: {
        addImageBlobHook: function (blob, cb) {
          uploadBlob(blob).then(function (path) { if (path) cb(path, blob.name || 'image'); })
            .catch(function () { toast('이미지 업로드 실패'); });
        },
      },
    });

    document.getElementById('galleryBtn').onclick = onGallery;
    document.getElementById('tipBtn').onclick = onTipbox;
    document.getElementById('saveBtn').onclick = function () { doSave(false); };
    document.getElementById('previewBtn').onclick = function () {
      if (S.diskSlug) window.open('/entry/' + encodeURIComponent(S.diskSlug), '_blank');
    };
    document.getElementById('pubBtn').onclick = doPublish;
  }

  function updateSlugHint() {
    var h = document.getElementById('slugHint'); if (!h) return;
    if (S.published) h.textContent = '발행된 글은 주소가 잠깁니다(제목을 바꿔도 주소는 안 바뀜).';
    else if (S.diskSlug) h.textContent = '주소를 바꾸면 저장 시 글 폴더 이름도 함께 바뀝니다(발행 전까지만).';
    else h.textContent = '제목에서 자동 생성됩니다. 발행 전까지 직접 수정할 수 있어요.';
  }

  function renderTags() {
    var box = document.getElementById('f_tags'); if (!box) return;
    box.innerHTML = '';
    S.tags.forEach(function (t, i) {
      var tag = el('<span class="tag">' + esc(t) + ' <button>✕</button></span>');
      tag.querySelector('button').onclick = function () { S.tags.splice(i, 1); renderTags(); };
      box.appendChild(tag);
    });
    var inp = el('<input type="text" placeholder="태그 입력 후 Enter">');
    inp.onkeydown = function (e) {
      if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); S.tags.push(inp.value.trim()); renderTags(); box.querySelector('input').focus(); }
    };
    box.appendChild(inp);
  }

  // ---------- 이미지 업로드(폴더 저장, base64 금지) ----------
  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  function ensureSlug() {
    if (!S.slug) { S.slug = slugify(S.title) || ('글-' + Date.now()); document.getElementById('f_slug').value = S.slug; }
    return S.slug;
  }
  function uploadBlob(blob) {
    var slug = S.diskSlug || ensureSlug();
    return blobToDataUrl(blob).then(function (dataUrl) {
      return api('upload', { slug: slug, filename: blob.name || 'image.png', dataUrl: dataUrl }).then(function (res) {
        if (!res.ok) { toast('업로드 실패: ' + (res.error || '')); return null; }
        if (!S.diskSlug) { S.diskSlug = slug; document.getElementById('previewBtn').disabled = false; }
        // 편집기 표시는 res.show(절대경로), 저장 시엔 collect()에서 './파일명'으로 변환
        return res.show;
      });
    });
  }

  function onGallery() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files); if (!files.length) return;
      toast(files.length + '장 업로드 중…');
      var seq = Promise.resolve(); var paths = [];
      files.forEach(function (f) { seq = seq.then(function () { return uploadBlob(f).then(function (p) { if (p) paths.push(p); }); }); });
      seq.then(function () {
        if (!paths.length) return;
        // 연속 이미지 → img-grid 규격(빈 줄로 구분된 개별 이미지)
        var md = '\n\n' + paths.map(function (p) { return '![](' + p + ')'; }).join('\n\n') + '\n\n';
        insertMarkdown(md);
        toast(paths.length + '장 삽입 완료(연속 이미지는 자동 그리드).');
      });
    };
    inp.click();
  }

  function onTipbox() {
    var kind = prompt('강조박스 종류: tip(팁) / warning(주의) / note(참고) 중 입력', 'tip');
    if (!kind) return;
    kind = kind.trim().toLowerCase();
    var map = { tip: '팁', 팁: 'tip', warning: '주의', 주의: 'warning', note: '참고', 참고: 'note' };
    var type = ['tip', 'warning', 'note'].indexOf(kind) >= 0 ? kind : (map[kind] || 'tip');
    if (['tip', 'warning', 'note'].indexOf(type) < 0) type = 'tip';
    var title = prompt('제목(비우면 기본 제목)', '') || '';
    var md = '\n\n> [!' + type + ']' + (title ? ' ' + title : '') + '\n> 내용을 여기에 쓰세요.\n\n';
    insertMarkdown(md);
  }

  // 커서 위치에 마크다운 삽입(위지윅/마크다운 모드 모두 대응)
  function insertMarkdown(md) {
    if (!editor) return;
    if (editor.isMarkdownMode && editor.isMarkdownMode()) {
      editor.insertText(md);
    } else {
      // 위지윅 모드: 전체 마크다운 끝에 붙이고 다시 로드(안정적)
      var cur = editor.getMarkdown();
      editor.setMarkdown(cur + md, false);
      editor.moveCursorToEnd && editor.moveCursorToEnd();
    }
  }

  // ---------- 저장 / 발행 ----------
  function collect() {
    // 편집기 표시용 이미지 경로(/write/media/슬러그/파일)를 저장용 './파일'로 되돌림
    S.body = editor.getMarkdown().replace(/\/write\/media\/[^\/)\s]+\//g, './');
    S.title = document.getElementById('f_title').value.trim();
    S.description = document.getElementById('f_desc').value.trim();
    return {
      title: S.title, slug: S.slug, description: S.description, tags: S.tags,
      body: S.body, draft: true, originalSlug: S.diskSlug || null,
    };
  }

  function doSave(silent) {
    if (!S.title) { toast('제목을 입력해 주세요.'); return Promise.resolve(false); }
    if (!S.slug) ensureSlug();
    var payload = collect();
    payload.draft = S.published ? false : true; // 발행글 재저장 시 draft 유지 안 함(읽기전용이라 실제론 여기 안 옴)
    return api('save', payload).then(function (res) {
      if (!res.ok) { toast('저장 실패: ' + (res.error || '')); return false; }
      S.diskSlug = res.slug; S.slug = res.slug;
      document.getElementById('f_slug').value = res.slug;
      document.getElementById('previewBtn').disabled = false;
      if (!silent) toast('임시저장 완료 (draft).');
      updateSlugHint();
      return true;
    });
  }

  function doPublish() {
    doSave(true).then(function (ok) {
      if (!ok) return;
      if (!confirm('발행하면 이 글이 실제 사이트에 올라가고(커밋+푸시), 주소가 고정됩니다.\n계속할까요?')) return;
      toast('발행 중… (커밋+푸시)');
      api('publish', { slug: S.diskSlug }).then(function (res) {
        if (!res.ok) { toast('발행 실패: ' + (res.error || '')); return; }
        S.published = true;
        alert('🚀 발행 완료!\n' + (res.message || '') + '\n\nCloudflare가 1~3분 뒤 자동 배포합니다.');
        showList();
      });
    });
  }

  // 시작
  showList();
})();
