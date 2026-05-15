// gaerhf-colormap.js — shared date-to-color pipeline for Map and Globe views.
//
// Single source of truth for:
//   - Color domain (fixed -50000..1500, matches the timeline slider).
//   - Date-to-[0,1] normalization with the log-threshold compression that
//     keeps the long Paleolithic tail readable.
//   - Ramp registry (grayscale, purple-orange). Add a ramp by adding one
//     entry to COLORMAP_RAMPS.
//   - Active selection (session-only) and a subscribe-style change event.
//   - getFigureColorDate(): the canonical "which date colors this figure"
//     accessor used by both views (midpoint of earliest/latest).
//   - bindColormapPicker(): builds the radio popup used by both views.
//
// Loaded before gaerhf-ui.js and gaerhf-globe.js so both can reference
// these globals directly. No module wrapper because the rest of the
// codebase is plain script-tag loaded.

// ── Color domain ─────────────────────────────────────────────────────────
const COLOR_MIN_DATE = -50000;
const COLOR_MAX_DATE = 1500;

// ── Log-threshold scaling ────────────────────────────────────────────────
let LOG_SCALE_THRESHOLD   = -4000;   // mutable; Ctrl+Shift+L slider writes here
const LOG_SCALE_FACTOR     = 4;
const LOG_REGION_PROPORTION = 0.15;

// Maps a date to [0,1]. Hybrid log-then-linear: dates older than the
// threshold are compressed into LOG_REGION_PROPORTION of the output range
// via a power-shaped log curve; dates younger map linearly across the rest.
// Moved verbatim from gaerhf-ui.js's former timelineScale().
function dateToScale(date, minDate, maxDate) {
    const d    = Number(date);
    const minN = Number(minDate != null ? minDate : COLOR_MIN_DATE);
    const maxN = Number(maxDate != null ? maxDate : COLOR_MAX_DATE);
    if (!isFinite(d) || !isFinite(minN) || !isFinite(maxN) || minN === maxN) {
        if (!isFinite(d) || !isFinite(minN) || !isFinite(maxN)) return 0.5;
        return 0;
    }

    try {
        if (minN >= LOG_SCALE_THRESHOLD) {
            return (d - minN) / (maxN - minN);
        }

        // Inclusive on the upper bound: when the threshold lands exactly
        // on maxN, the linear region is empty so we want pure log across
        // the whole range — otherwise the hybrid branch reserves 85% of
        // the bar for a zero-width linear region and every date ends up
        // crushed into the [0, LOG_REGION_PROPORTION] slice.
        if (maxN <= LOG_SCALE_THRESHOLD) {
            const logMin = Math.log(Math.abs(minN - LOG_SCALE_THRESHOLD) + 1);
            const logMax = Math.log(Math.abs(maxN - LOG_SCALE_THRESHOLD) + 1);
            const logVal = Math.log(Math.abs(d    - LOG_SCALE_THRESHOLD) + 1);
            const denom  = (logMax - logMin);
            if (!isFinite(denom) || denom === 0) {
                return Math.max(0, Math.min(1, (d - minN) / (maxN - minN)));
            }
            let normalized = (logVal - logMin) / denom;
            normalized = Math.max(0, Math.min(1, normalized));
            return Math.pow(normalized, LOG_SCALE_FACTOR);
        }

        if (d < LOG_SCALE_THRESHOLD) {
            const logMin = Math.log(Math.abs(minN - LOG_SCALE_THRESHOLD) + 1);
            const logMax = Math.log(1);
            const logVal = Math.log(Math.abs(d - LOG_SCALE_THRESHOLD) + 1);
            const denom  = (logMax - logMin);
            if (!isFinite(denom) || denom === 0) {
                const fallback = Math.max(0, Math.min(1, (d - minN) / (LOG_SCALE_THRESHOLD - minN)));
                return Math.pow(fallback, LOG_SCALE_FACTOR) * LOG_REGION_PROPORTION;
            }
            let normalized = (logVal - logMin) / denom;
            normalized = Math.max(0, Math.min(1, normalized));
            const compressed = Math.pow(normalized, LOG_SCALE_FACTOR);
            return compressed * LOG_REGION_PROPORTION;
        } else {
            const linearMin = LOG_SCALE_THRESHOLD;
            const linearMax = maxN;
            if (linearMax === linearMin) return 1;
            return LOG_REGION_PROPORTION + ((d - linearMin) / (linearMax - linearMin)) * (1 - LOG_REGION_PROPORTION);
        }
    } catch (err) {
        return Math.max(0, Math.min(1, (d - minN) / (maxN - minN)));
    }
}

function setLogScaleThreshold(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === LOG_SCALE_THRESHOLD) return;
    LOG_SCALE_THRESHOLD = n;
    _notifyColormapChange();
}

// ── Threshold slider visibility (shared between pickers + keyboard shortcut) ──
// The slider DOM (#threshold-control) is built in gaerhf-ui.js. This helper
// is the single place that flips its visibility, so the Map picker checkbox,
// the Globe picker checkbox, and the Ctrl/Cmd+Shift+L shortcut all stay in
// sync via the gaerhf:threshold-visibility-changed event.
function isThresholdSliderVisible() {
    const el = document.getElementById('threshold-control');
    if (!el) return false;
    return el.getAttribute('aria-hidden') !== 'true' && el.style.display !== 'none';
}

function setThresholdSliderVisible(visible) {
    const el = document.getElementById('threshold-control');
    if (!el) return;
    if (visible) {
        el.style.display = 'inline-block';
        el.setAttribute('aria-hidden', 'false');
    } else {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
    }
    document.dispatchEvent(new CustomEvent('gaerhf:threshold-visibility-changed', { detail: { visible: !!visible } }));
}

// ── Ramp registry ────────────────────────────────────────────────────────
// Each entry maps a scale value t in [0,1] to a CSS color string.
// markerBorder is the border color the view should pair with this ramp
// (dark border on a near-white fill, light border on saturated fills).
const COLORMAP_RAMPS = {
    grayscale: {
        id: 'grayscale',
        label: 'Black to White',
        scaleToColor(t) {
            const g = Math.round(Math.max(0, Math.min(1, t)) * 255);
            return `rgb(${g},${g},${g})`;
        },
        markerBorder: '#222',
    },
    'purple-orange': {
        id: 'purple-orange',
        label: 'Purple to Orange',
        scaleToColor(t) {
            const tt = Math.max(0, Math.min(1, t));
            let r, g, b;
            if (tt < 0.5) {
                const u = tt * 2;
                r = Math.round(139 + (37  - 139) * u);
                g = Math.round(61  + (117 - 61)  * u);
                b = Math.round(191 + (232 - 191) * u);
            } else {
                const u = (tt - 0.5) * 2;
                r = Math.round(37  + (255 - 37)  * u);
                g = Math.round(117 + (140 - 117) * u);
                b = Math.round(232 + (0   - 232) * u);
            }
            return `rgba(${r},${g},${b},0.9)`;
        },
        markerBorder: 'rgba(255,255,255,0.85)',
    },
};
const DEFAULT_COLORMAP_ID = 'grayscale';

// ── Active selection ─────────────────────────────────────────────────────
let _activeColormapId = DEFAULT_COLORMAP_ID;

function getActiveColormap() {
    return COLORMAP_RAMPS[_activeColormapId] || COLORMAP_RAMPS[DEFAULT_COLORMAP_ID];
}

function getActiveColormapId() {
    return _activeColormapId;
}

function setActiveColormap(id) {
    if (!COLORMAP_RAMPS[id] || id === _activeColormapId) return;
    _activeColormapId = id;
    _notifyColormapChange();
}

// ── Change subscription ──────────────────────────────────────────────────
// Both the threshold slider and the ramp picker fire the same event so
// listeners (Map markers, Globe markers, Globe legend, the OTHER view's
// picker UI) only need one wire-up.
const _colormapChangeListeners = [];

function onColormapChange(cb) {
    if (typeof cb === 'function') _colormapChangeListeners.push(cb);
}

function _notifyColormapChange() {
    _colormapChangeListeners.forEach(cb => {
        try { cb(getActiveColormap()); } catch (e) { console.warn('colormap listener error', e); }
    });
}

// ── Date → color convenience ─────────────────────────────────────────────
function dateToColor(date, rampId) {
    const ramp = rampId ? (COLORMAP_RAMPS[rampId] || getActiveColormap()) : getActiveColormap();
    return ramp.scaleToColor(dateToScale(date, COLOR_MIN_DATE, COLOR_MAX_DATE));
}

// Returns the date used to color a figure. Priority:
//   1. midpoint of :earliest-date and :latest-date if both set
//   2. :date
//   3. :approximate-date
//   4. whichever of :earliest-date / :latest-date is set alone
// Returns null only when no usable date exists.
function getFigureColorDate(f) {
    if (!f) return null;
    const num = v => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const e = num(f.earliestDate);
    const l = num(f.latestDate);
    if (e !== null && l !== null) return (e + l) / 2;
    const d = num(f.date);
    if (d !== null) return d;
    const a = num(f.approximateDate);
    if (a !== null) return a;
    if (e !== null) return e;
    if (l !== null) return l;
    return null;
}

// ── Legend sampling ──────────────────────────────────────────────────────
// Legends share the *scale axis* with markers: a marker at scale s is
// drawn with scaleToColor(s), so a legend sampled across t in [0,1] shows
// the full color range markers can take. The log-region's compressed
// width (LOG_REGION_PROPORTION) is visible directly because dateToScale
// maps the deep-Paleolithic dates into [0, LOG_REGION_PROPORTION].
function sampleRamp(rampId, n) {
    const ramp = rampId ? (COLORMAP_RAMPS[rampId] || getActiveColormap()) : getActiveColormap();
    const stops = Number.isFinite(n) && n > 1 ? Math.floor(n) : 40;
    const out = [];
    for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        out.push({ t, color: ramp.scaleToColor(t) });
    }
    return out;
}

// ── Picker widget builder ────────────────────────────────────────────────
// Renders a radio for each ramp into rootEl, wires change → setActiveColormap,
// and subscribes to colormap changes so the radio stays in sync when the
// *other* view's picker (or any code path) flips the active ramp.
function bindColormapPicker(rootEl) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const groupName = `colormap-${Math.random().toString(36).slice(2, 8)}`;

    Object.values(COLORMAP_RAMPS).forEach(ramp => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type    = 'radio';
        input.name    = groupName;
        input.value   = ramp.id;
        input.checked = (ramp.id === _activeColormapId);
        input.addEventListener('change', e => {
            if (e.target.checked) setActiveColormap(ramp.id);
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + ramp.label));
        rootEl.appendChild(label);
    });

    // Keep the radio state in sync when the *other* view's picker changes the active ramp.
    onColormapChange(() => {
        rootEl.querySelectorAll(`input[name="${groupName}"]`).forEach(r => {
            r.checked = (r.value === _activeColormapId);
        });
    });

    // Threshold-slider visibility toggle. Single shared state (the
    // #threshold-control element built in gaerhf-ui.js); both pickers'
    // checkboxes mirror each other via the custom event below.
    const sep = document.createElement('hr');
    sep.style.cssText = 'border:0;border-top:1px solid #ddd;margin:6px 0;';
    rootEl.appendChild(sep);

    const thresholdLabel = document.createElement('label');
    const thresholdBox   = document.createElement('input');
    thresholdBox.type    = 'checkbox';
    thresholdBox.checked = isThresholdSliderVisible();
    thresholdBox.addEventListener('change', e => {
        setThresholdSliderVisible(e.target.checked);
    });
    thresholdLabel.appendChild(thresholdBox);
    thresholdLabel.appendChild(document.createTextNode(' Threshold slider'));
    rootEl.appendChild(thresholdLabel);

    document.addEventListener('gaerhf:threshold-visibility-changed', e => {
        thresholdBox.checked = !!(e.detail && e.detail.visible);
    });
}
