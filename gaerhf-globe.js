// gaerhf-globe.js — globe view for gaerhf.github.io
// Reads shared globals from gaerhf-ui.js: figuresDict, currentSortedIndex,
// currentFigureId, currentKeywordHighlightIds, currentTab, showFigureDetails,
// sortFigures, renderGallery, highlightGalleryFigure.
// Shared utilities come from gaerhf-detail.js: thumbnailUrl, renderFigureHeader,
// renderFigureMetadata, renderFigureImage, createDetailWindowShell, etc.

/* globals figuresDict, currentSortedIndex, currentFigureId, currentKeywordHighlightIds,
   currentTab, showFigureDetails, sortFigures, renderGallery,
   highlightGalleryFigure, getOpenWindowFigureIds, thumbnailUrl,
   renderFigureHeader, renderFigureMetadata, renderFigureImage,
   createDetailWindowShell, getActiveWindow, _setActiveWindowBase, Globe,
   COLOR_MIN_DATE, COLOR_MAX_DATE, dateToColor, getActiveColormap,
   getFigureColorDate, sampleRamp, onColormapChange, bindColormapPicker */

// Color domain and ramp pipeline come from gaerhf-colormap.js (shared with the Map).

// Base-map options for the globe. Vendored locally because the free hosted
// equivalents (NASA eoimages, Solar System Scope, Wikimedia thumbnails) all
// either lack CORS or cap thumbnail rendering well below the resolutions
// that look sharp on a curved sphere. Each entry pairs an equirectangular
// texture URL with an optional bump map; both candidate textures already
// encode shading internally, so no bump map is needed.
const GLOBE_BASEMAPS = {
    // Natural Earth hypsometric tints with shaded relief (Tom Patterson,
    // 10m public-domain set, downsampled from the 10800×5400 TIF to 8K JPG).
    'terrain':     { globe: 'globe-textures/ne_hyp_8k.jpg',         bump: null },
    // NASA Blue Marble Next Generation, December 2004 mosaic, 5400×2700.
    'blue-marble': { globe: 'globe-textures/nasa_bluemarble_5k.jpg', bump: null },
};

let globeInstance    = null;
let globeHighlightId = null;
const markerElements = new Map(); // figureId → DOM marker div

// ── Date helpers ──────────────────────────────────────────────────────────────

function getFigureLatLng(f) {
    return f.representativeLatLongPoint || [0, 0];
}

function getFilteredGlobeFigures() {
    const ids = Array.isArray(currentSortedIndex) ? currentSortedIndex : [];
    return ids
        .map(id => figuresDict[id])
        .filter(f => {
            if (!f) return false;
            const ll = getFigureLatLng(f);
            return Array.isArray(ll) && ll.length === 2 && !ll.some(isNaN);
        });
}

// getFigureColorDate() (shared, from gaerhf-colormap.js) replaces the
// former local getGlobeMidDate() — both views now color by midpoint of
// earliest/latest, falling back to :date / :approximateDate.

function formatGlobeDateRange(f) {
    const fmt = n => n < 0
        ? `${Math.abs(Math.round(n)).toLocaleString()} BCE`
        : `${Math.round(n).toLocaleString()} CE`;
    if (f.date !== null && f.date !== undefined) return fmt(f.date);
    if (f.earliestDate !== null && f.earliestDate !== undefined &&
        f.latestDate   !== null && f.latestDate   !== undefined)
        return `${fmt(f.earliestDate)} – ${fmt(f.latestDate)}`;
    if (f.approximateDate !== null && f.approximateDate !== undefined) return `c. ${fmt(f.approximateDate)}`;
    return 'Date unknown';
}

// The top-of-page timescale strip serves as the colormap legend for both
// the Map and Globe — no per-view legend needed.

// ── Shared hover tooltip (reused across all markers) ─────────────────────────

const _globeTooltip = document.createElement('div');
_globeTooltip.id = 'globe-tooltip';
_globeTooltip.style.cssText = [
    'position:fixed', 'z-index:29000', 'pointer-events:none', 'display:none',
    'background:rgba(10,10,20,0.9)', 'border:1px solid rgba(255,255,255,0.22)',
    'border-radius:6px', 'padding:7px 10px',
    'font-family:system-ui,sans-serif', 'font-size:0.85em',
    'max-width:240px', 'line-height:1.5', 'color:#fff',
].join(';');
document.body.appendChild(_globeTooltip);

// ── Marker styling: primary / secondary / keyword / default ──────────────────
//
// Mirrors the map's behavior in highlightMapFigure():
//   - Primary  (active figure)                → pink ring
//   - Secondary (other figures with an open detail window) → blue ring
//   - Keyword match (no other state)          → gold ring
//   - Keyword search active but no match      → dimmed
//   - None of the above                       → default
//
// Both highlightGlobeFigure() and applyGlobeKeywordHighlights() funnel through
// _applyGlobeMarkerStyles() so the four states compose correctly. The same
// per-marker logic is also invoked from the htmlElement factory at marker
// creation time — globe.gl renders html elements asynchronously after
// htmlElementsData(), so markers may be created after a highlight was already
// requested (e.g. on the first switch from Map to Globe).
function _computeGlobeMarkerStyleContext() {
    const openIds = (typeof getOpenWindowFigureIds === 'function')
        ? getOpenWindowFigureIds()
        : [];
    return {
        secondarySet: new Set(openIds.filter(id => id !== globeHighlightId)),
        keywordSet:   new Set(currentKeywordHighlightIds || []),
        hasKeyword:   Array.isArray(currentKeywordHighlightIds) && currentKeywordHighlightIds.length > 0,
    };
}

function _applyGlobeMarkerStyleTo(figId, el, ctx) {
    ctx = ctx || _computeGlobeMarkerStyleContext();
    // Stacking is owned by the .globe-marker-primary / .globe-marker-secondary
    // CSS classes — inline z-index here would be clobbered by CSS2DRenderer's
    // per-frame depth-order rewrites.
    const isPrimary   = figId === globeHighlightId;
    const isSecondary = !isPrimary && ctx.secondarySet.has(figId);
    el.classList.toggle('globe-marker-primary',   isPrimary);
    el.classList.toggle('globe-marker-secondary', isSecondary);

    if (isPrimary) {
        el.style.opacity    = '1';
        el.style.background = '#fff';
        el.style.boxShadow  = '0 0 0 3px #CC79A7, 0 2px 8px rgba(0,0,0,0.7)';
        return;
    }
    el.style.background  = el.dataset.baseColor;
    el.style.borderColor = el.dataset.baseBorder || 'rgba(255,255,255,0.85)';
    if (isSecondary) {
        el.style.opacity   = '1';
        el.style.boxShadow = '0 0 0 3px #1976d2, 0 1px 4px rgba(0,0,0,0.55)';
    } else if (ctx.hasKeyword && ctx.keywordSet.has(figId)) {
        el.style.opacity   = '1';
        el.style.boxShadow = '0 0 0 2px rgba(230,159,0,0.8), 0 1px 4px rgba(0,0,0,0.55)';
    } else if (ctx.hasKeyword) {
        el.style.opacity   = '0.2';
        el.style.boxShadow = 'none';
    } else {
        el.style.opacity   = '';
        el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.55)';
    }
}

function _applyGlobeMarkerStyles() {
    const ctx = _computeGlobeMarkerStyleContext();
    markerElements.forEach((el, figId) => _applyGlobeMarkerStyleTo(figId, el, ctx));
}

function highlightGlobeFigure(figureId) {
    globeHighlightId = figureId || null;
    _applyGlobeMarkerStyles();
    // Gallery selection/scroll is handled by the shared highlightGalleryFigure()
    // path in gaerhf-ui.js, which targets the same #gallery on Map and Globe tabs.
}

// ── Keyword highlights ────────────────────────────────────────────────────────

function applyGlobeKeywordHighlights(/* ids — caller is expected to have updated
   currentKeywordHighlightIds before calling */) {
    _applyGlobeMarkerStyles();
    // Gallery keyword styling is handled by the shared highlightKeywordGalleryImages().
}

// ── Pan globe to a figure ─────────────────────────────────────────────────────

function panGlobeTo(figureId) {
    if (!globeInstance) return;
    const f = figuresDict[figureId];
    if (!f) return;
    const [lat, lng] = getFigureLatLng(f);
    // Preserve the user's current zoom level (altitude) — only rotate.
    const altitude = globeInstance.pointOfView().altitude;
    globeInstance.pointOfView({ lat, lng, altitude }, 1200);
}

// ── Visibility: which figures are currently in the screen viewport ────────────
//
// Two constraints must both hold for a figure to count as visible:
//   1. Not on the back hemisphere (occluded by the globe itself).
//      Tested via dot product against the horizon-cap cosine R/(R+altitude).
//   2. Inside the camera's frustum after perspective projection.
//      Tested via THREE's Vector3.project(camera) → NDC must lie in [-1, 1].
//
// Constraint #1 alone is insufficient at low altitudes: the horizon cap stays
// large (a 60–70° radius cap covers a quarter of the sphere) but the camera's
// FOV only shows a small wedge of it. Without constraint #2, "List" reports
// hundreds of figures even when the user has zoomed in tight.
function getVisibleGlobeFigureKeys() {
    if (!globeInstance) return [];
    const camera = globeInstance.camera();
    const pov    = globeInstance.pointOfView();
    if (!camera || !pov || pov.altitude == null) return [];

    // THREE isn't a global; reach it via a scene Vector3's constructor.
    const Vec3 = globeInstance.scene().position.constructor;

    const horizonCos = 1 / (1 + pov.altitude);
    const camNorm    = camera.position.clone().normalize();

    const visible = [];
    getFilteredGlobeFigures().forEach(f => {
        const [lat, lng] = getFigureLatLng(f);
        if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return;

        const coords = globeInstance.getCoords(lat, lng, 0);
        const v      = new Vec3(coords.x, coords.y, coords.z);

        // Occlusion: point on back of globe?
        if (camNorm.dot(v.clone().normalize()) < horizonCos) return;

        // Frustum: project to NDC and reject points outside [-1, 1] in x/y.
        v.project(camera);
        if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return;

        visible.push(f.id);
    });

    // Sort by date so gallery order matches the map gallery's convention.
    return (typeof sortFigures === 'function')
        ? sortFigures(visible, 'date')
        : visible;
}

function syncGlobeDataToCurrentSelection() {
    if (!globeInstance) return;

    const figures = getFilteredGlobeFigures();
    const visibleIds = new Set(figures.map(f => f.id));

    markerElements.forEach((_, figId) => {
        if (!visibleIds.has(figId)) markerElements.delete(figId);
    });

    globeInstance.htmlElementsData(figures);

    if (currentFigureId && !visibleIds.has(currentFigureId)) {
        highlightGlobeFigure(null);
    } else if (currentFigureId) {
        highlightGlobeFigure(currentFigureId);
    }

    if (currentKeywordHighlightIds && currentKeywordHighlightIds.length) {
        applyGlobeKeywordHighlights(currentKeywordHighlightIds);
    }
}

// ── Globe init (lazy — called once on first tab activation) ───────────────────

function initGlobe() {
    if (globeInstance) return;

    const figures = getFilteredGlobeFigures();

    // Compute starting POV: center on current figure if there is one,
    // otherwise leave the globe at globe.gl's default (lat:0, lng:0).
    let initialPov = { lat: 0, lng: 0, altitude: 2.5 };
    if (currentFigureId && figuresDict[currentFigureId]) {
        const [lat, lng] = getFigureLatLng(figuresDict[currentFigureId]);
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            initialPov = { lat, lng, altitude: 2.5 };
        }
    }

    // animateIn:false disables globe.gl's default "fly-in" intro animation.
    const initialBasemap = GLOBE_BASEMAPS.terrain;
    globeInstance = Globe({ animateIn: false })(document.getElementById('globe-inner'))
        .globeImageUrl(initialBasemap.globe)
        .bumpImageUrl(initialBasemap.bump)
        .backgroundImageUrl(null)
        // 0 means markers appear instantly at their final position.
        .htmlTransitionDuration(0)
        .htmlElementsData(figures)
        .htmlLat(d => getFigureLatLng(d)[0])
        .htmlLng(d => getFigureLatLng(d)[1])
        .htmlAltitude(0.003)
        .htmlElement(d => {
            const date         = getResolvedFigureColorDate(d);
            const color        = date !== null ? dateToColor(date) : '#aaa';
            const borderColor  = getActiveColormap().markerBorder;

            const div = document.createElement('div');
            div.dataset.baseColor  = color;
            div.dataset.baseBorder = borderColor;
            div.style.cssText = [
                'width:11px', 'height:11px',
                'margin-left:-5.5px', 'margin-top:-5.5px',
                'border-radius:50%',
                `background:${color}`,
                `border:1.5px solid ${borderColor}`,
                'box-shadow:0 1px 4px rgba(0,0,0,0.55)',
                'cursor:pointer',
                'transition:box-shadow 0.15s, opacity 0.15s',
                'position:relative',
                'pointer-events:auto',
            ].join(';');

            // Use pointerdown/pointerup — more reliable than 'click' with OrbitControls.
            let ptDownX = 0, ptDownY = 0;
            div.addEventListener('pointerdown', e => {
                e.stopPropagation();
                ptDownX = e.clientX;
                ptDownY = e.clientY;
            });
            div.addEventListener('pointercancel', () => { ptDownX = ptDownY = -9999; });
            div.addEventListener('pointerup', e => {
                e.stopPropagation();
                if (Math.hypot(e.clientX - ptDownX, e.clientY - ptDownY) < 8) {
                    try { showFigureDetails(d.id); } catch (err) { console.error(err); }
                }
            });

            div.addEventListener('mouseenter', e => {
                if (d.id !== globeHighlightId)
                    div.style.boxShadow = '0 0 0 3px rgba(255,255,255,0.8), 0 1px 6px rgba(0,0,0,0.6)';
                _globeTooltip.innerHTML = `
                    <b>${d.label}</b>
                    ${d.inModernCountry ? `<br><span style="color:#aaa">${d.inModernCountry}</span>` : ''}
                    <br><span style="color:#ddd">${formatGlobeDateRange(d)}</span>
                    ${d.materialNote ? `<br><span style="color:#999;font-size:0.9em">${d.materialNote}</span>` : ''}`;
                _globeTooltip.style.display = 'block';
                _globeTooltip.style.left    = (e.clientX + 14) + 'px';
                _globeTooltip.style.top     = (e.clientY + 14) + 'px';
            });
            div.addEventListener('mousemove', e => {
                _globeTooltip.style.left = (e.clientX + 14) + 'px';
                _globeTooltip.style.top  = (e.clientY + 14) + 'px';
            });
            div.addEventListener('mouseleave', () => {
                if (d.id !== globeHighlightId)
                    div.style.boxShadow = '0 1px 4px rgba(0,0,0,0.55)';
                _globeTooltip.style.display = 'none';
            });

            markerElements.set(d.id, div);
            // globe.gl may create this element after a highlight/keyword
            // request has already been issued (e.g. first Map→Globe switch).
            // Apply current state immediately so the marker doesn't paint with
            // default styling and miss the highlight.
            _applyGlobeMarkerStyleTo(d.id, div);
            return div;
        });

    // Snap to the chosen POV BEFORE the first paint — duration 0 means no tween.
    globeInstance.pointOfView(initialPov, 0);

    // Dim scene lights for a natural satellite look.
    globeInstance.scene().children
        .filter(obj => obj.isLight)
        .forEach(light => { light.intensity *= 0.55; });

    const controls       = globeInstance.controls();
    controls.autoRotate    = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    document.getElementById('globe-inner').addEventListener('pointerdown', () => {
        controls.autoRotate = false;
    });

    // Refresh the shared gallery as the user rotates the globe so it always
    // reflects the markers currently in the visible cap (mirrors the map's
    // moveend → renderGallery() pattern). Debounce to avoid thrashing during
    // inertia damping.
    let _galleryRefreshTimer = null;
    controls.addEventListener('change', () => {
        if (currentTab !== 'figure-globe') return;
        if (_galleryRefreshTimer) clearTimeout(_galleryRefreshTimer);
        _galleryRefreshTimer = setTimeout(() => {
            _galleryRefreshTimer = null;
            if (typeof renderGallery === 'function') renderGallery();
            if (currentFigureId && typeof highlightGalleryFigure === 'function')
                highlightGalleryFigure(currentFigureId);
        }, 180);
    });

    // Wire the base-map selector. Mirrors Leaflet's L.control.layers behavior
    // on the map tab: session-only, no URL/localStorage persistence.
    document.querySelectorAll('#globe-basemap-menu input[name="globe-basemap"]').forEach(radio => {
        radio.addEventListener('change', e => {
            const opt = GLOBE_BASEMAPS[e.target.value];
            if (!opt) return;
            globeInstance.globeImageUrl(opt.globe).bumpImageUrl(opt.bump);
        });
    });

    // Wire the colormap picker (sibling of the basemap-selector). Radios
    // are rendered from gaerhf-colormap.js's ramp registry so adding a
    // third ramp is a one-line change.
    const colormapMenu = document.getElementById('globe-colormap-menu');
    if (colormapMenu) bindColormapPicker(colormapMenu);

    // Re-color markers and redraw legend on any colormap change (ramp
    // switch in either view, or log-threshold slider).
    onColormapChange(() => {
        markerElements.forEach((el, figId) => {
            const f = figuresDict[figId];
            const date = f ? getResolvedFigureColorDate(f) : null;
            el.dataset.baseColor  = date !== null ? dateToColor(date) : '#aaa';
            el.dataset.baseBorder = getActiveColormap().markerBorder;
            _applyGlobeMarkerStyleTo(figId, el);
        });
    });

    // Apply any pre-existing highlight state. The initial POV was already set
    // above (before first paint) so we don't pan again here.
    syncGlobeDataToCurrentSelection();

    if (currentFigureId) highlightGlobeFigure(currentFigureId);
    if (currentKeywordHighlightIds && currentKeywordHighlightIds.length) {
        applyGlobeKeywordHighlights(currentKeywordHighlightIds);
    }
}
