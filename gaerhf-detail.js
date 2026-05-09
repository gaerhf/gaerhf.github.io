// gaerhf-detail.js — shared detail-window, image, and metadata utilities.
// Loaded by every GAERHF view (main map, 3D globe, …) before its own script.
// Provides: image helpers, isEmbeddable, site modal, date formatting,
//           Wikimedia API, figure rendering, drag/resize, detail window shell,
//           and the shared active-window state (getActiveWindow / _setActiveWindowBase).

// ---------------------------------------------------------------------------
// Image URL helpers — single source of truth for thumbnails/large naming.
// Index 0 → <id>.png; index i>0 → <id>-<i>.png.
// Order MUST match sources_by_subject in mk_thumbnails.py:
//   imageSourceUrls first, wikimediaImagePages second.
// ---------------------------------------------------------------------------
const thumbnailUrl = (id, index = 0) =>
    index === 0 ? `/thumbnails/${id}.png` : `/thumbnails/${id}-${index}.png`;
const largeUrl = (id, index = 0) =>
    index === 0 ? `/large/${id}.png` : `/large/${id}-${index}.png`;

// ---------------------------------------------------------------------------
// Embeddable-host check
// ---------------------------------------------------------------------------
const EMBEDDABLE_HOSTS = new Set([
    'en.wikipedia.org',
    'de.wikipedia.org',
    'it.wikipedia.org',
    'commons.wikimedia.org',
]);

function isEmbeddable(url) {
    try { return EMBEDDABLE_HOSTS.has(new URL(url).hostname); }
    catch { return false; }
}

// ---------------------------------------------------------------------------
// Site modal (lazy-created if not already in the DOM)
// ---------------------------------------------------------------------------
function _ensureSiteModal() {
    let modal = document.getElementById('site-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'site-modal';
        modal.className = 'gaerhf-site-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="gaerhf-modal-content">
                <div class="gaerhf-modal-header">
                    <button type="button" id="modal-go-btn" class="gaerhf-modal-btn">Go to Site</button>
                    <button type="button" id="modal-close-btn" class="gaerhf-modal-close-btn" title="Close modal">&times;</button>
                </div>
                <div class="gaerhf-modal-body">
                    <iframe id="modal-iframe" title="Embedded external site"></iframe>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#modal-close-btn').addEventListener('click', closeSiteModal);
    }
    return modal;
}

function openSiteModal(url) {
    const modal = _ensureSiteModal();
    const iframe = modal.querySelector('#modal-iframe');
    const goBtn  = modal.querySelector('#modal-go-btn');
    iframe.src = url;
    goBtn.onclick = () => window.open(url, '_blank');
    modal.hidden = false;
}

function closeSiteModal() {
    const modal = document.getElementById('site-modal');
    const iframe = modal && modal.querySelector('#modal-iframe');
    if (modal) modal.hidden = true;
    if (iframe) iframe.removeAttribute('src');
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------
function formatDateForDisplay(date) {
    if (date === null) return '';
    const year = Math.abs(date);
    const era  = date < 0 ? ' BCE' : ' CE';
    return `${year}${era}`;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons image URL resolution
// ---------------------------------------------------------------------------
async function getWikimediaImageUrl(pageUrl, width = 200) {
    try {
        const parts    = pageUrl.split('/');
        const filename = parts[parts.length - 1];
        const apiUrl   = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|thumburl&titles=${filename}&iiurlwidth=${width}&format=json&origin=*`;
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data   = await response.json();
        const pages  = data.query.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId !== '-1' && pages[pageId].imageinfo && pages[pageId].imageinfo[0].thumburl)
            return pages[pageId].imageinfo[0].thumburl;
        console.error('Could not retrieve thumbnail URL from Wikimedia API for:', pageUrl);
        return null;
    } catch (err) {
        console.error('Error fetching Wikimedia image info:', err);
        return null;
    }
}

function probeImageExists(url) {
    return new Promise(resolve => {
        const probe = new Image();
        probe.onload  = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = url;
    });
}

// Returns ordered image descriptors matching mk_thumbnails.py's sources_by_subject order:
// imageSourceUrls (direct) first, then wikimediaImagePages.
function getImageSources(figure) {
    const n = figure.imageSourceUrls.length;
    return [
        ...figure.imageSourceUrls.map((_, i) => ({
            thumb: thumbnailUrl(figure.id, i),
            large: largeUrl(figure.id, i),
        })),
        ...figure.wikimediaImagePages.map((_, i) => ({
            thumb: thumbnailUrl(figure.id, n + i),
            large: largeUrl(figure.id, n + i),
        })),
    ];
}

// ---------------------------------------------------------------------------
// Figure rendering (header, metadata, image carousel)
// ---------------------------------------------------------------------------
function renderFigureHeader(labelEl, figure) {
    if (!labelEl) return;
    labelEl.textContent = figure.label || figure.id;
    const linkIcon = document.createElement('a');
    linkIcon.href   = `/#${figure.id}`;
    linkIcon.target = '_blank';
    linkIcon.style.marginLeft  = '0.6em';
    linkIcon.style.fontSize    = '.5em';
    linkIcon.textContent = '🔗';
    labelEl.appendChild(linkIcon);
}

function renderFigureMetadata(infoEl, figure) {
    if (!infoEl) return;
    let html = '';
    if (figure.cultureLabel) {
        const cult = figure.cultureDescribedBy
            ? `<a href="${figure.cultureDescribedBy}" target="_blank">${figure.cultureLabel}</a>`
            : figure.cultureLabel;
        html += `<p><strong>Tradition/Culture:</strong> ${cult}</p>`;
    }
    if (figure.inModernCountry) html += `<p><strong>Modern Country:</strong> ${figure.inModernCountry}</p>`;
    if (figure.materialNote)    html += `<p><strong>Material:</strong> ${figure.materialNote}</p>`;
    if (figure.date !== null && figure.date !== undefined)
        html += `<p><strong>Date:</strong> ${formatDateForDisplay(figure.date)}</p>`;
    else if (figure.approximateDate !== null && figure.approximateDate !== undefined)
        html += `<p><strong>Approx. Date:</strong> ${formatDateForDisplay(figure.approximateDate)}</p>`;
    if (figure.earliestDate !== null && figure.earliestDate !== undefined) {
        const end = (figure.latestDate !== null && figure.latestDate !== undefined)
            ? ` to ${formatDateForDisplay(figure.latestDate)}` : '';
        html += `<p><strong>Date Range:</strong> ${formatDateForDisplay(figure.earliestDate)}${end}</p>`;
    }
    if (figure.note) html += `<p><strong>Note:</strong> ${figure.note}</p>`;
    infoEl.innerHTML = html;

    if (figure.describedBy && figure.describedBy.length > 0) {
        const chipRow = document.createElement('div');
        chipRow.className = 'link-chips';
        figure.describedBy.forEach(url => {
            const a     = document.createElement('a');
            a.href      = url;
            const embed = isEmbeddable(url);
            a.className = `link-chip ${embed ? 'link-chip--embed' : 'link-chip--external'}`;
            try { a.textContent = new URL(url).hostname.replace(/^www\./, ''); }
            catch { a.textContent = 'link'; }
            if (!embed) {
                a.target = '_blank';
                a.rel    = 'noopener noreferrer';
                const icon = document.createElement('span');
                icon.textContent = '↗';
                icon.setAttribute('aria-hidden', 'true');
                a.appendChild(icon);
            }
            chipRow.appendChild(a);
        });
        infoEl.appendChild(chipRow);
    }
}

async function renderFigureImage(imageDiv, figure) {
    if (!imageDiv) return;
    imageDiv.innerHTML = '';

    const sources = getImageSources(figure);
    if (sources.length === 0) {
        const localThumb = thumbnailUrl(figure.id);
        const localLarge = largeUrl(figure.id);
        const hasLocalImage = await probeImageExists(localThumb);
        if (!hasLocalImage) return;
        sources.push({ thumb: localThumb, large: localLarge });
    }

    let currentIndex    = 0;
    let showLargePreview = false;
    let swapToken       = 0;

    const img     = document.createElement('img');
    const detailA = document.createElement('a');
    detailA.title = 'Click for Google Image Search';
    detailA.appendChild(img);
    imageDiv.appendChild(detailA);

    function swapImageSmooth(nextSrc) {
        if (!nextSrc || img.dataset.currentSrc === nextSrc) return;
        const myToken = ++swapToken;
        const preload = new Image();
        preload.src   = nextSrc;

        const applySwap = () => {
            if (myToken !== swapToken) return;
            img.classList.add('is-swapping');
            img.src = nextSrc;
            img.dataset.currentSrc = nextSrc;
            requestAnimationFrame(() => {
                if (myToken !== swapToken) return;
                img.classList.remove('is-swapping');
            });
        };

        if (preload.complete) { applySwap(); return; }
        preload.addEventListener('load',  applySwap, { once: true });
        preload.addEventListener('error', applySwap, { once: true });
    }

    img.addEventListener('mouseover', () => {
        showLargePreview = true;
        swapImageSmooth(sources[currentIndex].large);
        imageDiv.style.paddingTop = '0';
    });
    img.addEventListener('mouseout', () => {
        showLargePreview = false;
        swapImageSmooth(sources[currentIndex].thumb);
        imageDiv.style.paddingTop = '';
    });

    const lensUrls = sources.length > 0
        ? [...figure.imageSourceUrls, ...figure.wikimediaImagePages.map(() => null)]
        : [];
    figure.wikimediaImagePages.forEach(async (page, i) => {
        const url = await getWikimediaImageUrl(page, 200);
        const idx = figure.imageSourceUrls.length + i;
        lensUrls[idx] = url;
        if (currentIndex === idx)
            detailA.href = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url || '')}`;
    });

    let prevBtn, nextBtn, counter;

    function showImage(index) {
        currentIndex    = index;
        const nextSrc   = showLargePreview ? sources[index].large : sources[index].thumb;
        swapImageSmooth(nextSrc);
        const preloadLarge = new Image();
        preloadLarge.src = sources[index].large;
        detailA.href = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(lensUrls[index] || '')}`;
        if (sources.length > 1) {
            counter.textContent          = `${index + 1} / ${sources.length}`;
            prevBtn.style.visibility     = 'visible';
            nextBtn.style.visibility     = 'visible';
        }
    }

    if (sources.length > 1) {
        const nav = document.createElement('div');
        nav.className = 'carousel-nav';
        prevBtn = document.createElement('button');
        prevBtn.className   = 'carousel-btn';
        prevBtn.textContent = '◀';
        prevBtn.addEventListener('click', () =>
            showImage((currentIndex - 1 + sources.length) % sources.length));
        counter = document.createElement('span');
        counter.className = 'carousel-counter';
        nextBtn = document.createElement('button');
        nextBtn.className   = 'carousel-btn';
        nextBtn.textContent = '▶';
        nextBtn.addEventListener('click', () =>
            showImage((currentIndex + 1) % sources.length));
        nav.append(prevBtn, counter, nextBtn);
        imageDiv.appendChild(nav);
    }

    showImage(0);
}

// ---------------------------------------------------------------------------
// Drag and resize
// ---------------------------------------------------------------------------
function dragElement(elmnt) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const handle = elmnt.querySelector('.detail-label-container') || elmnt;
    handle.onmousedown = (e) => {
        if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup   = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (ev) => {
            ev.preventDefault();
            pos1 = pos3 - ev.clientX;
            pos2 = pos4 - ev.clientY;
            pos3 = ev.clientX;
            pos4 = ev.clientY;
            elmnt.style.top  = (elmnt.offsetTop  - pos2) + 'px';
            elmnt.style.left = (elmnt.offsetLeft - pos1) + 'px';
            elmnt.style.right = 'auto';
        };
    };
}

function initResizers(elmnt) {
    elmnt.querySelectorAll('.resizer').forEach(resizer => {
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX, startY = e.clientY;
            const rect   = elmnt.getBoundingClientRect();
            const startW = rect.width, startH = rect.height, startL = rect.left;
            const type   = e.target.classList;

            const doDrag = (ev) => {
                elmnt.style.right  = 'auto';
                elmnt.style.bottom = 'auto';
                if (type.contains('resizer-r') || type.contains('resizer-br')) {
                    const w = startW + (ev.clientX - startX);
                    if (w > 200) elmnt.style.width = w + 'px';
                } else if (type.contains('resizer-l') || type.contains('resizer-bl')) {
                    const w = startW - (ev.clientX - startX);
                    if (w > 200) { elmnt.style.width = w + 'px'; elmnt.style.left = (startL + (ev.clientX - startX)) + 'px'; }
                }
                if (type.contains('resizer-b') || type.contains('resizer-br') || type.contains('resizer-bl')) {
                    const h = startH + (ev.clientY - startY);
                    if (h > 150) elmnt.style.height = h + 'px';
                }
            };
            const stopDrag = () => {
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup',   stopDrag);
                window.dispatchEvent(new Event('resize'));
            };
            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup',   stopDrag);
        });
    });
}

// ---------------------------------------------------------------------------
// Shared active-window state
// Consumers call _setActiveWindowBase(win) to manage z-index and CSS class.
// Each view wraps this with its own setActiveWindow() for view-specific side effects.
// ---------------------------------------------------------------------------
let _activeWindow = null;
let _topZIndex    = 5000;

function getActiveWindow() { return _activeWindow; }

function _setActiveWindowBase(win) {
    if (_activeWindow) _activeWindow.classList.remove('active-window');
    _activeWindow = win;
    win.classList.add('active-window');
    win.style.zIndex = ++_topZIndex;
}

// ---------------------------------------------------------------------------
// Detail window shell — creates the DOM structure shared by all views.
// Does NOT set initial position (caller does that) and does NOT add a
// mousedown listener for setActiveWindow (caller adds its own).
//
// Options:
//   onClose() — called after the window is removed from the DOM.
// ---------------------------------------------------------------------------
function createDetailWindowShell({ onClose } = {}) {
    const win = document.createElement('div');
    win.className = 'detail-window';
    win.innerHTML = `
        <div class="detail-label-container">
            <h2 class="detail-label">Loading</h2>
            <button class="window-close-btn" title="Close window">×</button>
        </div>
        <div class="figure-details-wrapper">
            <div class="detail-image"></div>
            <div class="detail-info"></div>
        </div>
        <div class="resizer resizer-r"></div>
        <div class="resizer resizer-l"></div>
        <div class="resizer resizer-b"></div>
        <div class="resizer resizer-br"></div>
        <div class="resizer resizer-bl"></div>
    `;

    document.body.appendChild(win);
    dragElement(win);
    initResizers(win);

    win.querySelector('.window-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (_activeWindow === win) _activeWindow = null;
        win.remove();
        if (onClose) onClose();
    });

    // Intercept embeddable-link clicks → site modal; external links fall through.
    const infoEl = win.querySelector('.detail-info');
    if (infoEl) {
        infoEl.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link && link.href && isEmbeddable(link.href)) {
                e.preventDefault();
                openSiteModal(link.href);
            }
        });
    }

    return win;
}

// ---------------------------------------------------------------------------
// Search utilities (usable by any view — requires MiniSearch on the page)
// ---------------------------------------------------------------------------

// Returns a MiniSearch instance pre-populated with all figures.
// Fields: label, materialNote, note, inModernCountry, cultureLabel.
function buildFigureSearchIndex(figures) {
    const ms = new MiniSearch({
        fields:       ['label', 'materialNote', 'note', 'inModernCountry', 'cultureLabel'],
        storeFields:  ['id', 'label'],
        idField:      'id',
        tokenize:     text => [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(m => m[0]),
        searchOptions: { prefix: true, fuzzy: 0.15, boost: { label: 2 } },
    });
    ms.addAll(figures.map(f => ({
        id:              f.id,
        label:           f.label           || '',
        materialNote:    f.materialNote     || '',
        note:            f.note            || '',
        inModernCountry: f.inModernCountry  || '',
        cultureLabel:    f.cultureLabel     || '',
    })));
    return ms;
}

// Wires a search input + autocomplete dropdown to a MiniSearch index.
// opts.onResults(ids) is called with matching figure IDs on every change;
// called with [] to signal "clear all highlights".
// Returns { clear() } to programmatically reset the search box.
function initSearchUI({ inputEl, suggestionsEl, searchIndex, figures, onResults, debounceMs = 300 }) {
    let timer = null;
    const byId = Object.fromEntries(figures.map(f => [f.id, f]));

    function doSearch(query) {
        suggestionsEl.innerHTML = '';
        if (!query.trim()) {
            suggestionsEl.hidden = true;
            onResults([]);
            return;
        }
        const results = searchIndex.search(query);
        const ids     = results.map(r => r.id);
        onResults(ids);
        results.slice(0, 8).forEach(r => {
            const li = document.createElement('li');
            li.textContent = byId[r.id]?.label || r.id;
            li.addEventListener('mousedown', e => {
                e.preventDefault();
                inputEl.value       = byId[r.id]?.label || r.id;
                suggestionsEl.hidden = true;
                onResults(ids);
            });
            suggestionsEl.appendChild(li);
        });
        suggestionsEl.hidden = results.length === 0;
    }

    inputEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => doSearch(inputEl.value), debounceMs);
    });
    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Escape') { inputEl.value = ''; doSearch(''); inputEl.blur(); }
        if (e.key === 'Enter')  doSearch(inputEl.value);
    });
    inputEl.addEventListener('blur',  () => setTimeout(() => { suggestionsEl.hidden = true; }, 180));
    inputEl.addEventListener('focus', () => { if (inputEl.value) doSearch(inputEl.value); });

    return { clear: () => { inputEl.value = ''; doSearch(''); } };
}

// ---------------------------------------------------------------------------
// Figure navigation utility
// ---------------------------------------------------------------------------

// Returns the next or previous figure ID by cycling through the active pool.
// If highlightIds is non-empty it acts as the pool; otherwise sortedIndex is used.
// direction: 'forward' | 'backward'
function figureNavigate(direction, currentId, sortedIndex, highlightIds) {
    const pool = (highlightIds && highlightIds.length) ? highlightIds : sortedIndex;
    if (!pool.length) return currentId;
    const i   = pool.indexOf(currentId);
    // If currentId not found, start from the beginning (forward) or end (backward).
    const idx = direction === 'forward'
        ? (i + 1) % pool.length
        : (i - 1 + pool.length) % pool.length;
    return pool[idx];
}

// ---------------------------------------------------------------------------
// Keyword search utilities (same model as the 2D map)
// ---------------------------------------------------------------------------

// Build an inverted keyword→figureIds index over figure text fields.
// Returns { searchIndex: MiniSearch, kwDict: { [token]: string[] } }
// The searchIndex searches token strings; kwDict maps each token to its figure IDs.
function buildKeywordSearchIndex(figures) {
    const wordRe  = /[\p{L}\p{N}]+/gu;
    const tokenize = text => (text != null ? String(text).toLowerCase().match(wordRe) : null) || [];

    const kwSets = {};
    for (const f of figures) {
        for (const field of [f.label, f.inModernCountry, f.materialNote, f.note, f.cultureLabel]) {
            for (const tok of tokenize(field)) {
                if (!kwSets[tok]) kwSets[tok] = new Set();
                kwSets[tok].add(f.id);
            }
        }
    }

    const docs = Object.entries(kwSets).map(([tok, ids]) => ({ id: tok, ids: [...ids] }));

    const ms = new MiniSearch({
        fields:        ['id'],
        storeFields:   ['ids'],
        searchOptions: { prefix: true },
    });
    ms.addAll(docs);

    const kwDict = Object.fromEntries(docs.map(d => [d.id, d.ids]));
    return { searchIndex: ms, kwDict };
}

// Wire a search input + dropdown to a keyword index.
// Dropdown shows matching keywords; highlights are committed on click, previewed on hover.
// opts.onResults(ids)    — called with figure IDs when user commits a keyword (or clears).
// opts.onHover(ids)      — called on dropdown item hover for preview.
// opts.onHoverEnd()      — called on dropdown item mouseleave to restore committed state.
// opts.onClose()         — called when dropdown hides (e.g. blur).
// Returns { clear() }.
function initKeywordSearchUI({ inputEl, suggestionsEl, searchIndex, kwDict,
                               onResults, onHover, onHoverEnd, onClose, debounceMs = 300 }) {
    let timer  = null;
    let isOpen = false;

    function setVisible(visible) {
        if (visible === isOpen) return;
        isOpen = visible;
        suggestionsEl.hidden = !visible;
        if (!visible && onClose) onClose();
    }

    function doSearch(query) {
        suggestionsEl.innerHTML = '';
        if (!query.trim()) {
            setVisible(false);
            onResults([]);
            return;
        }
        const results = searchIndex.search(query);
        if (!results.length) { setVisible(false); return; }

        results.slice(0, 8).forEach(r => {
            const ids = kwDict[r.id] || [];
            const li  = document.createElement('li');
            li.textContent = r.id;
            li.addEventListener('mousedown', e => {
                e.preventDefault();
                inputEl.value = r.id;
                setVisible(false);
                onResults(ids);
            });
            if (onHover)    li.addEventListener('mouseenter', () => onHover(ids));
            if (onHoverEnd) li.addEventListener('mouseleave', () => onHoverEnd());
            suggestionsEl.appendChild(li);
        });
        setVisible(true);
        // Do NOT call onResults here — highlights commit on click only, matching 2D behavior.
    }

    inputEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => doSearch(inputEl.value), debounceMs);
    });
    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Escape') { inputEl.value = ''; doSearch(''); inputEl.blur(); }
        if (e.key === 'Enter' && !inputEl.value.trim()) { doSearch(''); }
    });
    inputEl.addEventListener('blur',  () => setTimeout(() => setVisible(false), 180));
    inputEl.addEventListener('focus', () => { if (inputEl.value.trim()) doSearch(inputEl.value); });

    return { clear: () => { inputEl.value = ''; doSearch(''); } };
}
