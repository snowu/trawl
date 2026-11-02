// trawl review site: a reader for a repo's docs and diagrams. Data comes from trawl.json next to this page.
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const app = document.getElementById('app');
  let data;
  let byKey = new Map();
  let query = '';
  let typeFilter = '';

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 1800);
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      prompt(`Copy ${what}:`, text);
    }
  }

  // ── theme ─────────────────────────────────────────────────────────────
  function savedTheme() {
    try { return localStorage.getItem('trawl-theme'); } catch { return null; }
  }
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('trawl-theme', next); } catch {}
  }
  applyTheme(savedTheme());

  // ── routes: #/  #/diagrams  #/doc/<path.md>[/<anchor>] ────────────────
  function route() {
    const h = decodeURIComponent(location.hash.slice(1) || '/');
    if (h.startsWith('/doc/')) {
      const rest = h.slice(5);
      const m = /^(.*?\.(?:md|mmd))(?:\/(.*))?$/.exec(rest);
      return { view: 'doc', path: m ? m[1] : rest, anchor: m ? m[2] : undefined };
    }
    if (h.startsWith('/diagrams')) return { view: 'diagrams' };
    return { view: 'home' };
  }
  const docHref = (path, anchor) => `#/doc/${encodeURI(path)}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;

  // ── links to GitHub ──────────────────────────────────────────────────
  const blobUrl = (path, line) => data.repo && `${data.repo.url}/blob/${encodeURIComponent(data.repo.branch)}/${encodeURI(path)}${line ? `#L${line}` : ''}`;
  const discussUrl = (d) => data.repo && `${data.repo.url}/issues?q=${encodeURIComponent(`is:issue "${d.key}"`)}`;

  function requestBody(d, what) {
    const page = `${location.origin}${location.pathname}${docHref(d.doc, d.id)}`;
    const src = d.source.length > 3500 ? `${d.source.slice(0, 3500)}\n%% … truncated` : d.source;
    return [
      `**Diagram:** \`${d.key}\` · [view](${page})${data.repo ? ` · [source](${blobUrl(d.doc, d.line)})` : ''}`,
      '',
      '**What should change?**',
      '',
      what || '<!-- Describe the change: what is wrong or missing, and what it should show instead. -->',
      '',
      '<details><summary>Current Mermaid</summary>',
      '',
      '```mermaid',
      src,
      '```',
      '</details>',
      '',
      `<!-- trawl:ref ${d.key} -->`,
    ].join('\n');
  }

  function requestChange(d) {
    if (!data.repo) {
      copy(`Please update the diagram ${d.key}.\n\n${requestBody(d)}`, 'Change request');
      return;
    }
    const url = `${data.repo.url}/issues/new?${new URLSearchParams({
      title: `Diagram: ${d.title} (${d.key})`,
      body: requestBody(d),
      labels: 'trawl',
    })}`;
    window.open(url, '_blank', 'noopener');
  }

  // ── search ────────────────────────────────────────────────────────────
  function search(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits = [];
    for (const doc of data.docs) {
      for (const s of doc.sections) {
        const head = `${s.crumb} ${doc.title}`.toLowerCase();
        const body = s.text.toLowerCase();
        const path = doc.path.toLowerCase();
        let score = 0;
        let ok = true;
        for (const t of terms) {
          if (head.includes(t)) score += 8;
          else if (body.includes(t)) score += 1;
          else if (path.includes(t)) score += 2;
          else { ok = false; break; }
        }
        if (ok) hits.push({ doc, s, score });
      }
    }
    for (const d of data.diagrams) {
      const hay = `${d.title} ${d.id} ${d.type} ${d.source}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        const doc = data.docs.find((x) => x.path === d.doc);
        const s = doc && doc.sections.filter((x) => x.line <= d.line).at(-1);
        if (s && !hits.some((h) => h.s === s)) hits.push({ doc, s, score: 3 });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 60);
  }

  function highlight(text, terms) {
    let out = esc(text);
    for (const t of terms) {
      if (t.length < 2) continue;
      out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    }
    return out;
  }

  function snippet(text, terms) {
    const lower = text.toLowerCase();
    const at = Math.max(0, ...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).slice(0, 1).concat(0));
    const start = Math.max(0, at - 50);
    return (start ? '…' : '') + text.slice(start, start + 160);
  }

  // ── sidebar ───────────────────────────────────────────────────────────
  function renderNav(r) {
    const nav = $('.nav');
    if (query.trim()) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = search(query);
      nav.innerHTML = hits.length
        ? hits
            .map(
              (h) => `<a class="hit" href="${docHref(h.doc.path, h.s.anchor)}">
                <div class="crumb">${highlight(h.s.level ? h.s.crumb : h.doc.title, terms)}</div>
                <div class="path">${esc(h.doc.path)}</div>
                <div class="snip">${highlight(snippet(h.s.text, terms), terms)}</div></a>`,
            )
            .join('')
        : `<div class="empty">No matches for “${esc(query)}”.</div>`;
      return;
    }
    const groups = new Map();
    for (const d of data.docs) {
      const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(d);
    }
    const counts = new Map();
    for (const d of data.diagrams) counts.set(d.doc, (counts.get(d.doc) ?? 0) + 1);
    const broken = data.diagrams.filter((d) => d.error).length;
    let html = `<a href="#/" class="${r.view === 'home' ? 'on' : ''}">Overview</a>
      <a href="#/diagrams" class="${r.view === 'diagrams' ? 'on' : ''}">All diagrams<span class="count">${data.diagrams.length}${broken ? ` · ${broken} ✗` : ''}</span></a>`;
    for (const [dir, docs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      html += `<h4>${esc(dir || 'root')}</h4>`;
      for (const d of docs) {
        const on = r.view === 'doc' && r.path === d.path ? 'on' : '';
        const n = counts.get(d.path);
        html += `<a href="${docHref(d.path)}" class="${on}" title="${esc(d.path)}">${esc(d.title)}${n ? `<span class="count">${n}</span>` : ''}</a>`;
      }
    }
    nav.innerHTML = html;
  }

  // ── diagrams ──────────────────────────────────────────────────────────
  function figureHtml(d) {
    const actions = [
      `<button class="btn primary" data-act="request">Request a change</button>`,
      data.repo ? `<a class="btn" href="${esc(discussUrl(d))}" target="_blank" rel="noopener">Discussion</a>` : '',
      d.figma ? `<a class="btn" href="${esc(d.figma)}" target="_blank" rel="noopener">FigJam</a>` : '',
      `<button class="btn" data-act="source">Mermaid</button>`,
      `<button class="btn" data-act="copy">Copy</button>`,
      `<button class="btn" data-act="link" title="Copy a link to this diagram">Link</button>`,
    ].join('');
    const body = d.error
      ? `<div class="derr">This diagram doesn't parse:\n${esc(d.error)}</div>`
      : `<div class="dimg" data-act="zoom"><img src="${esc(d.svg)}" alt="${esc(d.title)}" loading="lazy"></div>`;
    return `<div class="dbar"><span class="chip">${esc(d.type ?? 'diagram')}</span>
      <span class="id">#${esc(d.id)}</span><span class="actions">${actions}</span></div>${body}<pre class="dsrc">${esc(d.source)}</pre>`;
  }

  function wireFigure(fig, d) {
    fig.id = `diagram-${d.id}`;
    fig.innerHTML = figureHtml(d);
    fig.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'request') requestChange(d);
      else if (act === 'source') fig.classList.toggle('show-src');
      else if (act === 'copy') copy(d.source, 'Mermaid');
      else if (act === 'link') copy(`${location.origin}${location.pathname}${docHref(d.doc, d.id)}`, 'Link');
      else if (act === 'zoom') lightbox(d);
    });
  }

  function lightbox(d) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<div class="lbar"><b>${esc(d.title)}</b><span style="opacity:.7">${esc(d.key)}</span>
      <span style="margin-left:auto;opacity:.7;font-size:13px">scroll to zoom · drag to pan · 0 to fit</span>
      <button class="btn" data-act="request">Request a change</button><button class="btn" data-act="close">Close</button></div>
      <div class="stage"><img src="${esc(d.svg)}" alt=""></div>`;
    document.body.append(box);
    const stage = $('.stage', box);
    const img = $('img', box);
    let s = 1, x = 0, y = 0;
    const apply = () => (img.style.transform = `translate(${x}px, ${y}px) scale(${s})`);
    const fit = () => {
      const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
      s = Math.min((stage.clientWidth - 40) / w, (stage.clientHeight - 40) / h, 3);
      x = (stage.clientWidth - w * s) / 2;
      y = (stage.clientHeight - h * s) / 2;
      apply();
    };
    img.complete ? fit() : img.addEventListener('load', fit);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.min(Math.max(s * k, 0.1), 12);
      x = mx - ((mx - x) * ns) / s;
      y = my - ((my - y) * ns) / s;
      s = ns;
      apply();
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY, x, y }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => { if (drag) { x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; apply(); } });
    stage.addEventListener('pointerup', () => (drag = null));
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === '0') fit(); };
    document.addEventListener('keydown', onKey);
    box.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') close();
      if (act === 'request') requestChange(d);
    });
  }

  function card(d) {
    const thumb = d.error ? `<div class="thumb err">✗ doesn't parse</div>` : `<div class="thumb"><img src="${esc(d.svg)}" alt="" loading="lazy"></div>`;
    return `<a class="card" href="${docHref(d.doc, d.id)}">${thumb}<div class="body"><div class="t">${esc(d.title)}</div>
      <div class="p">${esc(d.doc)}#${esc(d.id)}</div></div></a>`;
  }

  // ── views ─────────────────────────────────────────────────────────────
  function viewHome() {
    const broken = data.diagrams.filter((d) => d.error).length;
    const recent = data.diagrams.slice(0, 12);
    return `<h1 style="margin:4px 0 8px">${esc(data.name)}</h1>
      <p class="intro">Docs and diagrams from ${data.repo ? `<a href="${esc(data.repo.url)}" target="_blank" rel="noopener">${esc(data.repo.url.replace('https://github.com/', ''))}</a> (${esc(data.repo.branch)})` : 'this repo'}.
      Click a diagram to read it in context, zoom in, or ask for a change: requests become issues an agent can pick up.</p>
      <div class="stats"><span class="chip"><b>${data.docs.length}</b> docs</span><span class="chip"><b>${data.diagrams.length}</b> diagrams</span>
      ${broken ? `<span class="chip err"><b>${broken}</b> broken</span>` : ''}<span class="chip">updated ${esc(new Date(data.generatedAt).toLocaleString())}</span></div>
      <div class="grid">${recent.map(card).join('')}</div>
      ${data.diagrams.length > recent.length ? `<p><a href="#/diagrams">All ${data.diagrams.length} diagrams →</a></p>` : ''}`;
  }

  function viewDiagrams() {
    const types = [...new Set(data.diagrams.map((d) => d.type ?? 'other'))].sort();
    const list = data.diagrams.filter((d) => !typeFilter || (d.type ?? 'other') === typeFilter);
    return `<h1 style="margin:4px 0 14px">All diagrams</h1>
      <div class="filters"><button class="btn ${typeFilter ? '' : 'on'}" data-type="">All</button>
      ${types.map((t) => `<button class="btn ${t === typeFilter ? 'on' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <div class="grid">${list.map(card).join('')}</div>`;
  }

  function viewDoc(r) {
    const doc = data.docs.find((d) => d.path === r.path);
    if (!doc) return `<p class="empty">No document at ${esc(r.path)}.</p>`;
    const fm = Object.entries(doc.frontmatter || {}).filter(([k]) => k !== 'title');
    const broken = data.diagrams.filter((d) => d.doc === doc.path && d.error).length;
    return `<div class="doc-head"><div class="path">${esc(doc.path)}</div><div class="meta">
      ${fm.map(([k, v]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`).join('')}
      ${broken ? `<span class="chip err">${broken} broken diagram${broken > 1 ? 's' : ''}</span>` : ''}
      ${data.repo ? `<a class="chip" href="${esc(blobUrl(doc.path))}" target="_blank" rel="noopener">View on GitHub</a>` : ''}
      </div></div><article class="prose">${doc.html}</article>`;
  }

  function render() {
    const r = route();
    renderNav(r);
    const main = $('main');
    main.innerHTML = `<button class="btn menu-btn" data-act="menu">☰ Docs</button>` + (r.view === 'doc' ? viewDoc(r) : r.view === 'diagrams' ? viewDiagrams() : viewHome());
    for (const fig of main.querySelectorAll('figure.diagram')) {
      const d = byKey.get(fig.dataset.key);
      if (d) wireFigure(fig, d);
    }
    $('.side').classList.remove('open');
    if (r.view === 'doc' && r.anchor) {
      const el = document.getElementById(`diagram-${r.anchor}`) || document.getElementById(r.anchor);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        el.classList.add('flash');
      }
    } else window.scrollTo(0, 0);
    if (r.view === 'doc') {
      const doc = data.docs.find((d) => d.path === r.path);
      document.title = `${doc ? doc.title : r.path} · ${data.name}`;
    } else document.title = `${data.name} · docs`;
  }

  function shell() {
    app.innerHTML = `<div class="layout"><aside class="side">
      <div class="brand"><a href="#/">${esc(data.name)}</a><button class="theme" title="Toggle light/dark">◐</button></div>
      <input class="search" type="search" placeholder="Search docs and diagrams  /" aria-label="Search">
      <nav class="nav"></nav></aside><main></main></div>`;
    const input = $('.search');
    input.addEventListener('input', () => { query = input.value; renderNav(route()); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; query = ''; renderNav(route()); }
      if (e.key === 'Enter') $('.nav a')?.click();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input && !$('.lightbox')) { e.preventDefault(); input.focus(); }
    });
    $('.theme').addEventListener('click', toggleTheme);
    $('main').addEventListener('click', (e) => {
      const t = e.target.closest('[data-type]');
      if (t) { typeFilter = t.dataset.type; render(); }
      if (e.target.closest('[data-act="menu"]')) $('.side').classList.add('open');
    });
    $('.nav').addEventListener('click', () => $('.side').classList.remove('open'));
  }

  fetch('trawl.json')
    .then((r) => { if (!r.ok) throw new Error(`trawl.json: HTTP ${r.status}`); return r.json(); })
    .then((json) => {
      data = json;
      byKey = new Map(data.diagrams.map((d) => [d.key, d]));
      shell();
      render();
      addEventListener('hashchange', render);
    })
    .catch((e) => { app.innerHTML = `<p style="padding:24px">Couldn't load this site's data: ${esc(e.message)}</p>`; });
})();
