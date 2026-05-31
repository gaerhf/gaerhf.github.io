const turtleUrl = 'gaerhf.ttl';
const headerContainer = document.getElementById('header-container');

const minYear = -50000; // Minimum year
const maxYear = 1500;     // Maximum year

const SHIFT_HINT_HTML = `<div class="popup-hint">&#8679; Shift: open new window</div>`;

// thumbnailUrl, closeSiteModal, formatDateForDisplay,
// renderFigureHeader, renderFigureMetadata, renderFigureImage,
// createDetailWindowShell, getActiveWindow, _setActiveWindowBase
// — all provided by gaerhf-detail.js (loaded before this script in index.html).
//
// showGlobeTooltipForFigure, hideGlobeTooltip — provided by gaerhf-globe.js
// (loaded after this script, so the bindings exist by the time gallery
// hover handlers actually fire).

// Marker icon factory — single source of truth for marker size, shape, and border.
// borderColor defaults to #222 (back-compat); callers that know the active
// colormap pass its markerBorder so the border tracks the ramp.
// Visual state (size, shape, base shadow, highlight rings) lives in
// style.css under .custom-gray-marker .marker-inner; only the per-figure
// color and per-ramp border-color are set inline here.
function makeMarkerIcon(color, borderColor) {
    const bc = borderColor || '#222';
    return L.divIcon({
        className: 'custom-gray-marker',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
        tooltipAnchor: [0, -5],  // tip points to the top-center of the 10px marker
        html: `<div class="marker-inner" style="background:${color};border-color:${bc};"></div>`
    });
}

// Resolve the background + border colors a marker should use given its
// figure record and the currently-active colormap. One source of truth
// for "what color is this marker right now" — used both at marker
// creation and at every re-paint (filter change, colormap change).
function _resolveMarkerColors(figure) {
    const date = getResolvedFigureColorDate(figure);
    return {
        color:  date !== null ? dateToColor(date) : '#888',
        border: getActiveColormap().markerBorder,
    };
}

// Paint a Map marker's inner element in-place with the given colors.
// Returns false if the marker's DOM element isn't available yet
// (caller can then fall back to setIcon for a fresh render). Highlight
// state (rings, scale) is owned by CSS classes on the outer wrapper,
// so this only touches the two inline color properties.
function _paintMapMarker(marker, colors) {
    const el = marker && marker.getElement && marker.getElement();
    if (!el) return false;
    const inner = el.querySelector('.marker-inner');
    if (!inner) return false;
    inner.style.backgroundColor = colors.color;
    inner.style.borderColor     = colors.border;
    return true;
}

// Initialize the figures dictionary
let figuresDict = {};
let currentSortedIndex = [];
let figuresKWDict = {}; // keyword-to-IDs index, populated by initKeywordSearch
let tp;

let currentFigureId = null;
let currentTab = "figure-map";

let leafletMap = null;
let leafletMarkers = {}; // Place this at the top level

// Polygon spatial-selection state (view-agnostic). When a polygon is active,
// `polygonSelectedIds` holds the figure ids whose representative point falls
// inside it; gallery/list/keyboard-nav narrow to this set (see
// getVisibleInRangeFigureIds) and matching map markers get a red border (see
// _applyMapMarkerStyleTo). The Leaflet drawing UI lives in initializeMap; this
// state + pointInPolygon + recomputePolygonSelection are reusable by the Globe.
let polygonSelectionActive = false;
let polygonSelectedIds = new Set();
// Leaflet drawing handles for the active polygon (Map-only UI).
let polygonDrawState = { polygon: null, vertices: [], ring: [] };
let polygonControlButton = null;

let thresholdDebounceTimer = null;
let isShiftKeyDown = false;
let isTimescaleThumbDragging = false;
let currentKeywordHighlightIds = [];
let selectedEarliestYear = minYear;
let selectedLatestYear = maxYear;
let dateRangeApplyInFlight = false;
let dateRangeApplyTimer = null;
let pendingDateRangeApply = null;
let dateRangeApplyNeedsRerun = false;
let hasAutoOpenedInitialFigure = false;
let timescaleDragPopupState = {
    active: false,
    showStart: false,
    showEnd: false,
    startYear: null,
    endYear: null,
};

// f.colorDate is set once in buildFiguresInfoDict() (number or null).
function getResolvedFigureColorDate(f) {
    return f ? f.colorDate : null;
}
function normalizeDateRange(startYear, endYear) {
    const start = Number(startYear);
    const end = Number(endYear);
    if (!isFinite(start) || !isFinite(end)) {
        return [minYear, maxYear];
    }
    return start <= end ? [start, end] : [end, start];
}

function scaleToDate(scaleValue, minDate, maxDate) {
    const minN = Number(minDate);
    const maxN = Number(maxDate);
    const target = Math.max(0, Math.min(1, Number(scaleValue)));
    if (!isFinite(minN) || !isFinite(maxN) || minN === maxN) {
        return minYear;
    }

    if (target <= 0) return minN;
    if (target >= 1) return maxN;

    let lo = minN;
    let hi = maxN;
    for (let i = 0; i < 36; i++) {
        const mid = (lo + hi) / 2;
        const midScale = timelineScale(mid, minN, maxN);
        if (!isFinite(midScale)) {
            break;
        }
        if (midScale < target) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return Math.round((lo + hi) / 2);
}

function getTimescaleSideMarginPx(scaleDiv) {
    if (!scaleDiv) return 20;
    try {
        const raw = getComputedStyle(scaleDiv).getPropertyValue('--timescale-side-margin');
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    } catch (e) {
        // ignore and use default
    }
    return 20;
}

async function applySelectedDateRange(startYear, endYear) {
    const [normalizedStart, normalizedEnd] = normalizeDateRange(startYear, endYear);
    selectedEarliestYear = normalizedStart;
    selectedLatestYear = normalizedEnd;
    await loadAndDisplayFigures();
}

// Runs the pending date-range apply. If another apply is already in-flight,
// flag a rerun so the latest range eventually wins; otherwise await the apply
// and re-schedule if new input arrived during the await.
async function runPendingDateRangeApply() {
    if (dateRangeApplyInFlight) {
        dateRangeApplyNeedsRerun = true;
        return;
    }

    const payload = pendingDateRangeApply;
    if (!payload) return;

    pendingDateRangeApply = null;
    dateRangeApplyInFlight = true;
    await applySelectedDateRange(payload[0], payload[1]);
    dateRangeApplyInFlight = false;

    if (dateRangeApplyNeedsRerun || pendingDateRangeApply) {
        dateRangeApplyNeedsRerun = false;
        scheduleDateRangeApply();
    }
}

function scheduleDateRangeApply() {
    pendingDateRangeApply = [selectedEarliestYear, selectedLatestYear];

    if (dateRangeApplyTimer) clearTimeout(dateRangeApplyTimer);

    dateRangeApplyTimer = setTimeout(() => {
        dateRangeApplyTimer = null;
        runPendingDateRangeApply();
    }, 100);
}

function flushDateRangeApplyNow() {
    pendingDateRangeApply = [selectedEarliestYear, selectedLatestYear];

    if (dateRangeApplyTimer) {
        clearTimeout(dateRangeApplyTimer);
        dateRangeApplyTimer = null;
    }

    runPendingDateRangeApply();
}

// Open a marker callout using a Leaflet Tooltip (direction-aware, no auto-pan).
// 'top' when the marker has room above; 'bottom' when near the map's top edge.
function openAdaptivePopup(marker, content) {
    if (!leafletMap || !marker) return;
    const pt = leafletMap.latLngToContainerPoint(marker.getLatLng());
    const mapSize = leafletMap.getSize();
    const topThreshold = Math.max(140, Math.floor(mapSize.y * 0.28));
    const direction = pt.y < topThreshold ? 'bottom' : 'top';
    marker.unbindTooltip();
    marker.unbindPopup();
    marker.bindTooltip(content, {
        direction,
        offset: direction === 'bottom' ? [0, 10] : [0, 10],
        opacity: 1,
        permanent: false,
        sticky: false,
        interactive: false,
        className: 'popup-like'
    });
    marker.openTooltip();

    // Tooltips with images can grow after open; force a position/layout refresh
    // when media resolves so the tip stays anchored to the marker.
    const tooltip = marker.getTooltip && marker.getTooltip();
    const refreshTooltipPosition = () => {
        try { tooltip && tooltip.update && tooltip.update(); } catch { }
    };

    requestAnimationFrame(refreshTooltipPosition);
    requestAnimationFrame(refreshTooltipPosition);

    const tooltipEl = tooltip && tooltip.getElement ? tooltip.getElement() : null;
    if (!tooltipEl) return;

    tooltipEl.querySelectorAll('img').forEach((img) => {
        if (img.complete) return;
        img.addEventListener('load', refreshTooltipPosition, { once: true });
        img.addEventListener('error', refreshTooltipPosition, { once: true });
    });
}

// Single hover-card builder used by every Map and Globe hover/click/Tab
// callsite. The same content shows everywhere — including the shift-key
// hint, since showFigureDetails() honors isShiftKeyDown regardless of
// which view triggered it. Layout is horizontal: text column on the
// left, small thumbnail on the right, shift hint full-width below.
//
// Options:
//   mode      — 'light' (default) or 'dark'. Renders as a
//               `.popup-card--dark` modifier on the inner card; CSS
//               uses :has() to flip the outer shell colors.
//   thumbnail — boolean (default true). When false, the thumbnail
//               frame is omitted entirely and the text fills the body.
function buildHoverContent(figure, { mode = 'light', thumbnail = true } = {}) {
    if (!figure) return '';
    const title    = figure.label || figure.id;
    const country  = figure.inModernCountry
        ? `<div class="popup-meta popup-country">${figure.inModernCountry}</div>` : '';
    const dateStr  = formatFigureDateRange(figure);
    const date     = dateStr
        ? `<div class="popup-meta popup-date">${dateStr}</div>` : '';
    const material = figure.materialNote
        ? `<div class="popup-meta popup-material">${figure.materialNote}</div>` : '';
    const thumb    = thumbnail
        ? `<div class="popup-thumb-frame"><img class="popup-thumb" src="${thumbnailUrl(figure.id)}" loading="lazy" alt=""></div>`
        : '';
    const modeCls  = mode === 'dark' ? ' popup-card--dark' : '';
    return `
        <div class="popup-card${modeCls}">
            <div class="popup-body">
                <div class="popup-text">
                    <div class="popup-title">${title}</div>
                    ${country}${date}${material}
                </div>
                ${thumb}
            </div>
            ${SHIFT_HINT_HTML}
        </div>`;
}

// Convenience functions
/**
 * @param {L.Map} leafletMap - The Leaflet map instance.
 * @param {Object.<string, L.Marker>} leafletMarkers - A key-value object where keys are figureIds and values are Leaflet marker instances.
 * @returns {Array<string>} An array of keys (figureIds) for markers currently visible on the map.
 */
function getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers) {
    // Ensure both map and markers object are provided
    if (!leafletMap || !leafletMarkers) {
        console.error("Error: leafletMap and leafletMarkers are required.");
        return [];
    }

    // Get the current geographical bounds of the visible map area
    const mapBounds = leafletMap.getBounds();

    const visibleMarkerKeys = []

    // Iterate over each key-value pair in the leafletMarkers object
    for (const figureId in leafletMarkers) {
        // Ensure the property belongs to the object itself and not its prototype chain
        if (Object.prototype.hasOwnProperty.call(leafletMarkers, figureId)) {
            const marker = leafletMarkers[figureId];

            // Check if the marker is a valid Leaflet marker and has a getLatLng method
            if (marker && typeof marker.getLatLng === 'function') {
                const markerLatLng = marker.getLatLng();

                // Check if the marker's geographical coordinates are within the map's bounds
                if (mapBounds.contains(markerLatLng)) {
                    // If visible, add its key (figureId) to the results array
                    visibleMarkerKeys.push(figureId);
                }
            } else {
                console.warn(`Warning: Object with key '${figureId}' is not a valid Leaflet marker.`);
            }
        }
    }

    return visibleMarkerKeys;
}

// Canonical date accessors — single source of truth for the "effective date" of a figure.
// Use ?? (not ||) so that year 0 CE (a valid date) is not treated as falsy.
function getFigureStart(f) { return f.earliestDate ?? f.date ?? f.approximateDate; }
function getFigureEnd(f) { return f.latestDate ?? f.date ?? f.approximateDate; }

function sortFigures(figureIds, sortBy = 'date') {
    const sortedFigures = [...figureIds]; // Create a copy to avoid mutating the original array

    sortedFigures.sort((aId, bId) => {
        const a = figuresDict[aId]; // Retrieve the figure object for ID `aId`
        const b = figuresDict[bId]; // Retrieve the figure object for ID `bId`

        if (sortBy === 'date') {
            let dateA = a.date !== null ? a.date : (a.earliestDate || a.approximateDate);
            let dateB = b.date !== null ? b.date : (b.earliestDate || b.approximateDate);

            if (dateA !== null && dateB !== null) {
                const comparison = dateA - dateB;
                if (comparison !== 0) {
                    return comparison;
                }
                // If earliestDate is equal, compare latestDate
                if (a.latestDate !== null && b.latestDate !== null) {
                    return a.latestDate - b.latestDate;
                }
            } else if (dateA !== null) {
                return -1;
            } else if (dateB !== null) {
                return 1;
            }
        }

        // Fallback to sorting by label
        const labelA = a.label || a.id;
        const labelB = b.label || b.id;
        return labelA.localeCompare(labelB);
    });

    return sortedFigures;
}

async function buildFiguresInfoDict($rdf) {

    const rdfType = $rdf.sym('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

    const figureType = $rdf.sym('urn:gaerhf:id:human-figure');
    const groupType = $rdf.sym('urn:gaerhf:id:group-of-human-figures');

    const describedByProp = $rdf.sym('urn:gaerhf:id:described-by');

    const rdfsLabelProp = $rdf.sym('http://www.w3.org/2000/01/rdf-schema#label');

    const dateProp = $rdf.sym('urn:gaerhf:id:date');
    const approximateDateProp = $rdf.sym('urn:gaerhf:id:approximate-date');
    const earliestDateProp = $rdf.sym('urn:gaerhf:id:earliest-date');
    const latestDateProp = $rdf.sym('urn:gaerhf:id:latest-date');

    const noteProp = $rdf.sym('urn:gaerhf:id:note');
    const cultureProp = $rdf.sym('urn:gaerhf:id:art-historical-culture-or-tradition');
    const inModernCountryProp = $rdf.sym('urn:gaerhf:id:in-modern-country-note');
    const materialNoteProp = $rdf.sym('urn:gaerhf:id:material-note');
    const wikipediaImagePageProp = $rdf.sym('urn:gaerhf:id:wikimedia-commons-image-page');
    const thumbnailImageProp = $rdf.sym('urn:gaerhf:id:thumbnail-image'); // New property
    const latLongProp = $rdf.sym('urn:gaerhf:id:representative-latlong-point');

    const processedDict = {};

    try {
        await Promise.all([figureType, groupType].map(async type => {
            const subjectsOfType = tp.each(null, rdfType, type);
            console.log("Found subjects of type:", type.uri, "Count:", subjectsOfType.length);

            await Promise.all(subjectsOfType.map(async subject => {
                const shortId = subject.uri.replace('urn:gaerhf:id:', '');

                const label = tp.anyValue(subject, rdfsLabelProp) || shortId;

                const dateStr = tp.anyValue(subject, dateProp) || null;
                const earliestDateStr = tp.anyValue(subject, earliestDateProp) || null;
                const latestDateStr = tp.anyValue(subject, latestDateProp) || null;
                const approximateDateStr = tp.anyValue(subject, approximateDateProp) || null;

                // Convert date strings to numbers
                const date = dateStr ? parseFloat(dateStr) : null;
                const earliestDate = earliestDateStr ? parseFloat(earliestDateStr) : null;
                const latestDate = latestDateStr ? parseFloat(latestDateStr) : null;
                const approximateDate = approximateDateStr ? parseFloat(approximateDateStr) : null;

                const note = tp.anyValue(subject, noteProp) || null;

                const culture = tp.any(subject, cultureProp);
                let cultureShortId = null;
                let cultureLabel = null;
                let cultureDescribedBy = null;

                // Extract all string/literal values consistently - no RDF nodes should reach figuresDict
                const inModernCountry = tp.anyValue(subject, inModernCountryProp) || null;
                const materialNote = tp.anyValue(subject, materialNoteProp) || null;
                const imageSourceUrls = tp.each(subject, thumbnailImageProp).map(n => n.value);
                const wikimediaImagePages = tp.each(subject, wikipediaImagePageProp).map(n => n.value);
                const describedBy = tp.each(subject, describedByProp).map(val => val.value);

                const latLongNode = tp.any(subject, latLongProp);
                let representativeLatLongPoint = null;
                if (latLongNode && latLongNode.termType === 'Collection') {
                    // It's an RDF list/collection - extract numeric values only
                    const items = latLongNode.elements.map(el => parseFloat(el.value));
                    if (items.length === 2 && items.every(v => !isNaN(v))) {
                        representativeLatLongPoint = items;
                    }
                }

                if (culture) {
                    cultureShortId = culture.uri.replace('urn:gaerhf:id:', '');
                    // Extract label and describedBy as plain strings
                    cultureLabel = tp.anyValue(culture, rdfsLabelProp) || null;
                    cultureDescribedBy = tp.anyValue(culture, describedByProp) || null;
                }

                const figureInfo = {
                    id: shortId,
                    label: label,  // always a string
                    date: date,  // number or null
                    earliestDate: earliestDate,  // number or null
                    latestDate: latestDate,  // number or null
                    approximateDate: approximateDate,  // number or null
                    describedBy: describedBy,  // array of strings
                    note: note,  // string or null
                    culture: cultureShortId,  // string or null
                    cultureLabel: cultureLabel,  // string or null
                    cultureDescribedBy: cultureDescribedBy,  // string or null
                    materialNote: materialNote,  // string or null
                    inModernCountry: inModernCountry,  // string or null
                    imageSourceUrls: imageSourceUrls,       // array of direct image URLs
                    wikimediaImagePages: wikimediaImagePages, // array of Wikimedia Commons page URLs
                    representativeLatLongPoint: representativeLatLongPoint,  // [number, number] or null
                };
                figureInfo.colorDate = getFigureColorDate(figureInfo);
                processedDict[shortId] = figureInfo;
            }));
        }));
        return processedDict;
    } catch (error) {
        console.error("Error processing store:", error);
        return {};
    }
}

// Filter figures based on the selected date range
function filterFiguresByDateRange(startYear, endYear) {
    if (!figuresDict || Object.keys(figuresDict).length === 0) {
        console.warn("Figures dictionary is empty or undefined.");
        return [];
    }

    const [rangeStart, rangeEnd] = normalizeDateRange(startYear, endYear);

    return Object.keys(figuresDict).filter(figureId => {
        const figure = figuresDict[figureId];
        if (!figure) {
            console.warn("Figure not found for ID:", figureId);
            return false;
        }

        const figureStartDate = getFigureStart(figure);
        const figureEndDate = getFigureEnd(figure);

        if (figureStartDate == null && figureEndDate == null) {
            console.warn("Figure has no valid dates:", figureId, figure);
            return false;
        }

        const resolvedStart = Number(figureStartDate ?? figureEndDate);
        const resolvedEnd = Number(figureEndDate ?? figureStartDate);
        if (!isFinite(resolvedStart) || !isFinite(resolvedEnd)) {
            return false;
        }

        const effectiveStart = Math.min(resolvedStart, resolvedEnd);
        const effectiveEnd = Math.max(resolvedStart, resolvedEnd);

        // Overlap semantics: figure's time span intersects selected span.
        return effectiveEnd >= rangeStart && effectiveStart <= rangeEnd;
    });
}

// Ray-casting point-in-polygon test. `ring` is an array of [lat, lng] vertices
// (open or closed). Pure — no Leaflet dependency — so the Globe can reuse it
// with a ring it builds its own way.
function pointInPolygon(lat, lng, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i];   // lat, lng
        const [yj, xj] = ring[j];
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Rebuild polygonSelectedIds from the current figures, keeping those whose
// representative point falls inside `ring`. Figures with no coordinate are
// excluded. Callers repaint markers / re-render views afterward.
function recomputePolygonSelection(ring) {
    polygonSelectedIds = new Set();
    if (!Array.isArray(ring) || ring.length < 3) return;
    Object.keys(figuresDict).forEach(figureId => {
        const pt = figuresDict[figureId] && figuresDict[figureId].representativeLatLongPoint;
        if (!pt) return;
        if (pointInPolygon(pt[0], pt[1], ring)) polygonSelectedIds.add(figureId);
    });
}

// Timescale display settings — the log-threshold pipeline now lives in
// gaerhf-colormap.js. This forwarder keeps the many scale-positioning
// call sites (renderFiguresAsTimescale, etc.)
// working unchanged. The Ctrl+Shift+L slider writes its value through
// setLogScaleThreshold() in the shared module.
function timelineScale(date, minDate, maxDate) {
    return dateToScale(date, minDate, maxDate);
}

function initializeMap() {
    leafletMap = L.map('figure-map', {
        worldCopyJump: true,
        keyboard: false,  // CRITICAL: Disable Leaflet's keyboard handler completely
        boxZoom: false    // Shift+drag box-zoom conflicts with Shift+click for new windows
    }).setView([20, 15], 2); // World view

    // Base layers — exposed as a radio control (L.control.layers) in the top-right.
    // All three are usable without an API key.
    const baseLayers = {
        // World Physical Map: hypsographic tints + shaded relief, no labels,
        // no borders. Native tiles cap at z8; let Leaflet overzoom so the user
        // can still zoom further without the layer disappearing.
        'Terrain': L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}',
            {
                attribution: 'Tiles &copy; Esri &mdash; Source: US National Park Service',
                maxNativeZoom: 8,
                maxZoom: 19,
            }
        ),
        // Esri WorldShadedRelief: standalone grayscale shaded relief — readable
        // on its own (unlike WorldHillshade, which is meant as a translucent
        // overlay on a colored base). No labels, no borders.
        'Terrain (Hillshade)': L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
            {
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri',
                maxNativeZoom: 13,
                maxZoom: 19,
            }
        ),
        'Satellite': L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
                maxZoom: 19,
            }
        ),
        'Minimal': L.tileLayer(
            'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
            {
                attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                subdomains: 'abcd',
                maxZoom: 19,
            }
        ),
        'OpenStreetMap': L.tileLayer(
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                attribution: '&copy; OpenStreetMap contributors',
                maxZoom: 19,
            }
        ),
    };
    baseLayers['Terrain'].addTo(leafletMap);
    L.control.layers(baseLayers, null, { position: 'topright', collapsed: true }).addTo(leafletMap);

    // Bind the Map's colormap picker. Markup lives in index.html as
    // #map-colormap-control — identical structure & placement to the
    // Globe's picker so the widget is in the same spot across views.
    // Stop interactions from bubbling to the map underneath.
    const mapColormapControl = document.getElementById('map-colormap-control');
    if (mapColormapControl) {
        L.DomEvent.disableClickPropagation(mapColormapControl);
        L.DomEvent.disableScrollPropagation(mapColormapControl);
        bindColormapPicker(document.getElementById('map-colormap-menu'));
    }

    // Re-render markers whenever the active colormap (or log threshold) changes.
    // Wired once per Leaflet map instance; initializeMap() runs once.
    onColormapChange(() => {
        try { updateMarkerColors(); } catch (e) { /* ignore */ }
    });
    // Disable automatic map panning for ALL popups globally (simplifies hover behavior)
    try { L.Popup.prototype.options.autoPan = false; } catch (e) { /* ignore if Leaflet not loaded */ }
    // Explicitly raise popup pane z-index in JS in case CSS loads late or is overridden
    try { leafletMap.getPanes().popupPane.style.zIndex = '20000'; } catch (e) { /* ignore */ }

    // Add zoom-to-all-markers button
    L.Control.ZoomToAll = L.Control.extend({
        onAdd: function (map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
            container.innerHTML = '🌐';
            container.style.backgroundColor = 'white';
            container.style.width = '30px';
            container.style.height = '30px';
            container.style.lineHeight = '30px';
            container.style.textAlign = 'center';
            container.style.cursor = 'pointer';
            container.style.fontSize = '18px';
            container.title = 'Zoom to all markers';
            container.onclick = function () {
                const allMarkers = Object.values(leafletMarkers);
                if (allMarkers.length === 0) return;
                const bounds = L.latLngBounds(allMarkers.map(m => m.getLatLng()));
                // keep padding 0. Any other value zooms too far out.
                map.fitBounds(bounds, { padding: [0, 0] });
            };
            return container;
        }
    });
    L.control.zoomToAll = function (opts) {
        return new L.Control.ZoomToAll(opts);
    };
    L.control.zoomToAll({ position: 'topleft' }).addTo(leafletMap);

    // Polygon-selection toggle — stacks directly under the zoom-to-all button
    // (both topleft). Drops a draggable 5-vertex polygon; gallery/list/nav
    // narrow to figures inside it. See togglePolygonSelection().
    L.Control.PolygonSelect = L.Control.extend({
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
            container.innerHTML = '⬠';
            container.style.backgroundColor = 'white';
            container.style.width = '30px';
            container.style.height = '30px';
            container.style.lineHeight = '30px';
            container.style.textAlign = 'center';
            container.style.cursor = 'pointer';
            container.style.fontSize = '18px';
            container.title = 'Select figures with a polygon';
            // Don't let clicks/drags on the button reach the map.
            L.DomEvent.disableClickPropagation(container);
            container.onclick = function () { togglePolygonSelection(); };
            polygonControlButton = container;
            return container;
        }
    });
    L.control.polygonSelect = function (opts) {
        return new L.Control.PolygonSelect(opts);
    };
    L.control.polygonSelect({ position: 'topleft' }).addTo(leafletMap);

    // Zoom and pan both change which markers are in view, so both must
    // refresh the gallery and restore highlights the same way.
    const onMapViewChange = () => {
        renderGallery();
        highlightGalleryFigure(currentFigureId);
        try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch (e) { /* ignore */ }
        try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
    };
    leafletMap.on('zoomend', onMapViewChange);
    leafletMap.on('moveend', onMapViewChange);
}

// --- Polygon spatial selection (Leaflet drawing UI) -----------------------

// Seed a regular pentagon inscribed in ~40% of the current viewport, so the
// polygon is fully on-screen and easy to grab at any zoom level. Returns an
// array of 5 [lat, lng] vertices.
function seedPolygonRing() {
    const b = leafletMap.getBounds();
    const center = b.getCenter();
    const latR = (b.getNorth() - b.getSouth()) * 0.4 / 2;
    const lngR = (b.getEast() - b.getWest()) * 0.4 / 2;
    const ring = [];
    for (let i = 0; i < 5; i++) {
        const angle = Math.PI / 2 - i * (2 * Math.PI / 5); // clockwise from top
        ring.push([
            center.lat + latR * Math.sin(angle),
            center.lng + lngR * Math.cos(angle),
        ]);
    }
    return ring;
}

// Recompute the selection from the current ring and refresh every view that
// reads it: map marker borders, gallery, and the list modal if it's open.
function refreshAfterPolygonChange() {
    recomputePolygonSelection(polygonDrawState.ring);
    _applyMapMarkerStyles(currentFigureId);
    renderGallery();
    highlightGalleryFigure(currentFigureId);
    const listModal = document.getElementById('list-modal');
    if (listModal && !listModal.hidden) openListModal();
}

// A draggable vertex handle. Dragging rewrites its slot in the shared ring and
// redraws the polygon live; on release the selection recomputes.
function makeVertexMarker(latlng, index) {
    const icon = L.divIcon({
        className: 'polygon-vertex-handle',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
    });
    const m = L.marker(latlng, { icon, draggable: true, zIndexOffset: 3000 }).addTo(leafletMap);
    m.on('drag', () => {
        const p = m.getLatLng();
        polygonDrawState.ring[index] = [p.lat, p.lng];
        if (polygonDrawState.polygon) polygonDrawState.polygon.setLatLngs(polygonDrawState.ring);
    });
    m.on('dragend', () => { refreshAfterPolygonChange(); });
    return m;
}

// Shift+drag anywhere on the polygon body translates the whole shape (and its
// vertex handles) by the cursor delta. Plain (no-shift) drags fall through to
// normal map panning. Mirrors the vertex makeVertexMarker pattern: move live,
// recompute the selection only on release.
function onPolygonShiftDrag(e) {
    if (!(e.originalEvent && e.originalEvent.shiftKey)) return;
    L.DomEvent.stop(e.originalEvent); // suppress map pan for this gesture
    leafletMap.dragging.disable();
    const startLatLng = e.latlng;
    const startRing = polygonDrawState.ring.map(v => v.slice());
    const onMove = (ev) => {
        const dLat = ev.latlng.lat - startLatLng.lat;
        const dLng = ev.latlng.lng - startLatLng.lng;
        polygonDrawState.ring = startRing.map(([la, ln]) => [la + dLat, ln + dLng]);
        polygonDrawState.polygon.setLatLngs(polygonDrawState.ring);
        polygonDrawState.vertices.forEach((m, i) => m.setLatLng(polygonDrawState.ring[i]));
    };
    const onUp = () => {
        leafletMap.off('mousemove', onMove);
        leafletMap.off('mouseup', onUp);
        leafletMap.dragging.enable();
        refreshAfterPolygonChange();
    };
    leafletMap.on('mousemove', onMove);
    leafletMap.on('mouseup', onUp);
}

function activatePolygonSelection() {
    if (!leafletMap) return;
    polygonDrawState.ring = seedPolygonRing();
    polygonDrawState.polygon = L.polygon(polygonDrawState.ring, {
        color: '#D55E00',
        weight: 2,
        fillColor: '#D55E00',
        fillOpacity: 0.08,
        // interactive so the body can receive the shift-drag mousedown; plain
        // drags still pass through to the map (we only stop on shift).
        interactive: true,
    }).addTo(leafletMap);
    polygonDrawState.polygon.on('mousedown', onPolygonShiftDrag);
    polygonDrawState.vertices = polygonDrawState.ring.map((latlng, i) => makeVertexMarker(latlng, i));
    polygonSelectionActive = true;
    if (polygonControlButton) polygonControlButton.classList.add('polygon-control-active');
    refreshAfterPolygonChange();
}

function deactivatePolygonSelection() {
    if (polygonDrawState.polygon) leafletMap.removeLayer(polygonDrawState.polygon);
    polygonDrawState.vertices.forEach(m => leafletMap.removeLayer(m));
    polygonDrawState = { polygon: null, vertices: [], ring: [] };
    polygonSelectionActive = false;
    polygonSelectedIds = new Set();
    if (polygonControlButton) polygonControlButton.classList.remove('polygon-control-active');
    // Repaint markers and return gallery/list to the viewport-based set.
    _applyMapMarkerStyles(currentFigureId);
    renderGallery();
    highlightGalleryFigure(currentFigureId);
    const listModal = document.getElementById('list-modal');
    if (listModal && !listModal.hidden) openListModal();
}

function togglePolygonSelection() {
    if (polygonSelectionActive) deactivatePolygonSelection();
    else activatePolygonSelection();
}

function renderFiguresOnMap(figuresArray) {
    if (!leafletMap) initializeMap();

    // We'll update markers in-place where possible to preserve highlight styles
    // Do NOT recreate all markers — update existing markers' background color, create missing ones,
    // and remove markers that are no longer needed. This avoids losing border/boxShadow highlights.

    // Update existing markers in-place where possible, create markers for figures
    // that don't yet have one, and remove any leftover markers not in figuresArray.
    const toKeep = new Set();

    figuresArray.forEach(figureId => {
        const figure = figuresDict[figureId];
        if (!figure || !figure.representativeLatLongPoint) return;

        const [lat, lng] = figure.representativeLatLongPoint;
        const colors = _resolveMarkerColors(figure);

        if (leafletMarkers[figureId]) {
            const existingMarker = leafletMarkers[figureId];
            // Fall back to setIcon if the element isn't in the DOM yet — the
            // fresh icon HTML will carry the right colors when Leaflet renders it.
            if (!_paintMapMarker(existingMarker, colors)) {
                existingMarker.setIcon(makeMarkerIcon(colors.color, colors.border));
            }
            toKeep.add(figureId);
            return;
        }

        // Otherwise create a new marker (first time seen)
        const icon = makeMarkerIcon(colors.color, colors.border);

        const marker = L.marker([lat, lng], { icon }).addTo(leafletMap);
        marker.on('click', () => {
            highlightMapFigure(figureId);
            highlightGalleryFigure(figureId);
            showFigureDetails(figureId);
            openAdaptivePopup(marker, buildHoverContent(figure));
        });
        marker.on('mouseover', () => {
            openAdaptivePopup(marker, buildHoverContent(figure));
            try { showTimescaleHoverOverlay(figureId); } catch (e) { /* ignore */ }
        });

        marker.on('mouseout', () => {
            try { clearTimescaleHoverOverlay(); } catch (e) { /* ignore */ }
            marker._hoverCloseTimer = setTimeout(() => {
                try { marker.closeTooltip(); } catch { }
                marker._hoverCloseTimer = null;
            }, 250);
        });

        leafletMarkers[figureId] = marker; // Store marker
        toKeep.add(figureId);
    });

    // Remove any markers that were not kept (i.e., not present in figuresArray)
    Object.keys(leafletMarkers).forEach(existingId => {
        if (!toKeep.has(existingId)) {
            const m = leafletMarkers[existingId];
            try {
                if (m && leafletMap && leafletMap.removeLayer) leafletMap.removeLayer(m);
            } catch (e) { /* ignore */ }
            delete leafletMarkers[existingId];
        }
    });

    // Reapply selected figure highlight, then keyword highlights — the
    // selected-figure path clears boxShadow on all markers, so keyword
    // highlights must be reapplied after it to stay visible.
    try {
        if (currentFigureId && leafletMarkers[currentFigureId]) {
            highlightMapFigure(currentFigureId);
            highlightGalleryFigure(currentFigureId);
        }
        highlightKeywordMarkers(currentKeywordHighlightIds || []);
    } catch (err) {
        // ignore
    }

}

async function showFigureDetails(figureId, { markAsRecent = false } = {}) {
    const figure = figuresDict[figureId];
    if (!figure) return;

    const targetWindow = (isShiftKeyDown || !getActiveWindow()) ? createDetailWindow(figureId) : getActiveWindow();
    targetWindow.dataset.figureId = figureId;
    // Mark active synchronously so a rapid second click reuses this window
    // even if renderFigureImage below throws or is still awaiting.
    setActiveWindow(targetWindow);

    if (markAsRecent) {
        clearTimeout(targetWindow._recentOpenTimer);
        targetWindow.classList.add('recently-opened');
        targetWindow._recentOpenTimer = setTimeout(() => {
            targetWindow.classList.remove('recently-opened');
        }, 3000);
    }

    renderFigureHeader(targetWindow.querySelector('.detail-label'), figure);
    renderFigureMetadata(targetWindow.querySelector('.detail-info'), figure);
    await renderFigureImage(targetWindow.querySelector('.detail-image'), figure);
    updateDetailWindowRangeState();
    try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { }
}

function updateDetailWindowRangeState() {
    const inRangeIds = new Set(Array.isArray(currentSortedIndex) ? currentSortedIndex : []);
    document.querySelectorAll('.detail-window[data-figure-id]').forEach((win) => {
        const figureId = win.dataset.figureId;
        const outOfRange = !figureId || !inRangeIds.has(figureId);
        win.classList.toggle('out-of-range', outOfRange);
    });
}

function getTopmostOpenDetailWindow() {
    const windows = Array.from(document.querySelectorAll('.detail-window[data-figure-id]'));
    if (windows.length === 0) return null;
    return windows.reduce((best, candidate) => {
        const bestZ = Number(best.style.zIndex || 0);
        const candidateZ = Number(candidate.style.zIndex || 0);
        return candidateZ > bestZ ? candidate : best;
    }, windows[0]);
}

function syncActiveFigureFromOpenWindows() {
    const nextWindow = getTopmostOpenDetailWindow();
    if (nextWindow) {
        setActiveWindow(nextWindow);
        return;
    }

    currentFigureId = null;
    highlightMapFigure(null);
    highlightGalleryFigure(null);
    highlightGlobeFigure(null);
    try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { }
}

function createDetailWindow(figureId) {
    const count   = document.querySelectorAll('.detail-window').length;
    const _fig    = figuresDict[figureId];
    const _lng    = _fig && _fig.representativeLatLongPoint ? _fig.representativeLatLongPoint[1] : null;
    const _placeLeft = _lng !== null && _lng >= 0; // eastern hemisphere → left side keeps marker visible

    const win = createDetailWindowShell({
        onClose: () => {
            syncActiveFigureFromOpenWindows();
        },
    });

    win.style.top = `${110 + (count * 20)}px`;
    if (_placeLeft) {
        win.style.left  = `${30 + (count * 20)}px`;
        win.style.right = 'auto';
    } else {
        win.style.right = `${30 + (count * 20)}px`;
        win.style.left  = 'auto';
    }

    win.addEventListener('mousedown', () => setActiveWindow(win));
    return win;
}

function setActiveWindow(win) {
    _setActiveWindowBase(win);

    const figId = win.dataset.figureId;
    if (figId) {
        currentFigureId = figId;
        if (window.location.hash !== `#${figId}`) {
            history.replaceState(null, '', `#${figId}`);
        }
        highlightMapFigure(figId);
        highlightGalleryFigure(figId);
        highlightGlobeFigure(figId);
        try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { }
    }
}

async function loadAndDisplayFigures() {
    const filteredFiguresIndex = filterFiguresByDateRange(selectedEarliestYear, selectedLatestYear);
    console.log("Filtered figures count:", filteredFiguresIndex.length);

    const sortedFiguresIndex = sortFigures(filteredFiguresIndex, 'date');
    console.log("Sorted figures count:", sortedFiguresIndex.length);

    currentSortedIndex = sortedFiguresIndex;

    renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);

    setTimeout(() => {
        if (leafletMap) {
            leafletMap.invalidateSize();
        }
        renderFiguresOnMap(currentSortedIndex);
        syncGlobeDataToCurrentSelection();
        document.body.classList.add('gallery-visible');
        renderGallery();

        // Highlight current figure without zooming in — keep the world view.
        if (currentFigureId && leafletMarkers[currentFigureId]) {
            const thisEl = leafletMarkers[currentFigureId].getElement && leafletMarkers[currentFigureId].getElement();
            if (thisEl) {
                highlightMapFigure(currentFigureId);
                highlightGalleryFigure(currentFigureId);
            }
        }
    }, 200);

    updateDetailWindowRangeState();

    const openWindowIds = getOpenWindowFigureIds();
    if (openWindowIds.length > 0) {
        return;
    }

    if (sortedFiguresIndex.length === 0) {
        hasAutoOpenedInitialFigure = true;
        return;
    }

    if (hasAutoOpenedInitialFigure) {
        return;
    }

    // Default display logic: respect URL hash if present, otherwise default to first item
    let initialFigureId = sortedFiguresIndex.length > 0 ? sortedFiguresIndex[0] : null;
    if (currentFigureId && sortedFiguresIndex.includes(currentFigureId)) {
        initialFigureId = currentFigureId;
    }
    const hash = window.location.hash;
    if (hash && hash.length > 1) {
        const figureId = hash.substring(1);
        if (figuresDict[figureId] && sortedFiguresIndex.includes(figureId)) {
            initialFigureId = figureId;
        }
    }

    if (initialFigureId) {
        showFigureDetails(initialFigureId);
        hasAutoOpenedInitialFigure = true;
    }
}

// Initialize the RDF store from the public turtle file.
async function initializeStore($rdf) {
    tp = $rdf.graph();
    try {
        const response = await fetch(turtleUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const turtleData = await response.text();

        const contentType = 'text/turtle';
        const baseUrl = document.location.href;
        await $rdf.parse(turtleData, tp, baseUrl, contentType);
        console.log("Number of triples in triplestore:", tp.statements.length);
        return true;
    } catch (error) {
        console.error("Error initializing store:", error);
        return false;
    }
}

(async function initializeAndLoadFigures() {
    if (await initializeStore($rdf)) {
        figuresDict = await buildFiguresInfoDict($rdf);
        // figuresDict is built once and not mutated by filters; wire the
        // keyword search a single time so listeners on #search-input don't
        // stack with each loadAndDisplayFigures() call.
        renderKeywordSearch();
        await loadAndDisplayFigures();
    }
})();

// Track Shift key state globally
document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
        isShiftKeyDown = true;
    }
});

document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
        isShiftKeyDown = false;
    }
});

// Reset on window blur (in case user releases key while window not focused)
window.addEventListener('blur', () => {
    isShiftKeyDown = false;
});

document.addEventListener('keydown', (event) => {

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === "Tab") {
        // Prevent default scrolling behavior
        event.preventDefault();

        // Decide navigation set: keyword highlights if present, otherwise visible figures
        let navigationSet = [];

        // Visible-figure ids for the active spatial view, or null if the
        // current tab has no spatial filter (list/about).
        let visibleFigures = null;
        if (currentTab === 'figure-globe' || currentTab === 'figure-map') {
            visibleFigures = getVisibleInRangeFigureIds();
        }

        if (currentKeywordHighlightIds && currentKeywordHighlightIds.length > 0) {
            // Navigate through keyword-highlighted figures
            let keywordSet = sortFigures(currentKeywordHighlightIds, 'date');

            // On spatial tabs, filter to keyword figures visible in the viewport
            // so Tab only cycles through markers the user can actually see.
            if (visibleFigures !== null) {
                if (visibleFigures.length > 0) {
                    const visibleSet = new Set(visibleFigures);
                    navigationSet = keywordSet.filter(id => visibleSet.has(id));
                } else {
                    navigationSet = keywordSet; // fallback to all keyword highlights if no visible figures
                }
            } else {
                // On non-spatial tabs (list/about), use all keyword figures
                navigationSet = keywordSet;
            }
        } else {
            // No keyword highlights: cycle through visible figures on spatial
            // tabs (map/globe); fall back to the full sorted index elsewhere.
            if (visibleFigures !== null) {
                if (visibleFigures.length === 0) return;
                navigationSet = visibleFigures;
            } else {
                navigationSet = currentSortedIndex;
            }
        }

        if (!navigationSet || navigationSet.length === 0) return;

        let targetIndex = 0;

        // Check if currentFigureId is in the navigation set
        const idx = navigationSet.indexOf(currentFigureId);

        if (idx !== -1) {
            // Current figure is in the set, move to next/previous
            if (event.key === 'ArrowLeft') {
                targetIndex = idx > 0 ? idx - 1 : navigationSet.length - 1;
            } else { // ArrowRight or Tab
                targetIndex = idx < navigationSet.length - 1 ? idx + 1 : 0;
            }
        } else {
            // Current figure not in set, go to first
            targetIndex = 0;
        }

        const targetFigureId = navigationSet[targetIndex];

        // Arrow/Tab navigation updates the info window only — no transient
        // marker popup, on either view. showFigureDetails() opens a new
        // window when none is active, otherwise updates the active one.
        showFigureDetails(targetFigureId);
        highlightMapFigure(targetFigureId);
        highlightGalleryFigure(targetFigureId);

        // Clear any hover tooltip the user may have left open before
        // they started keyboarding, on both views.
        Object.values(leafletMarkers).forEach(m => {
            clearTimeout(m._hoverCloseTimer);
            m._hoverCloseTimer = null;
            try { m.closeTooltip(); } catch {}
        });
        hideGlobeTooltip();
    }

});

// Tab functionality for the UI
// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Re-render the top-of-page timescale legend (colored gradient + figure
    // dots) whenever the active colormap or log threshold changes. Wired
    // here so it fires regardless of which tab the user is on.
    onColormapChange(() => {
        try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { /* ignore */ }
    });

    // Fade all open info windows while the user hovers the gallery strip so
    // thumbnails stay readable even when a popup overlaps from below.
    const galleryContainer = document.getElementById('gallery-container');
    if (galleryContainer) {
        galleryContainer.addEventListener('mouseenter', () => document.body.classList.add('gallery-hovered'));
        galleryContainer.addEventListener('mouseleave', () => document.body.classList.remove('gallery-hovered'));
    }

    const galleryListBtn = document.getElementById('gallery-list-btn');
    if (galleryListBtn) {
        galleryListBtn.addEventListener('click', () => {
            openListModal();
        });
    }

    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            button.classList.add('active');
            currentTab = tabName;
            document.body.classList.toggle('about-tab', tabName === 'about');
            document.body.classList.toggle('globe-tab-active', tabName === 'figure-globe');
            document.body.classList.toggle('gallery-visible',
                tabName === 'figure-map' || tabName === 'figure-globe');
            const activeContent = document.getElementById(`${tabName}-container`);
            if (activeContent) activeContent.classList.add('active');

            if (tabName === 'figure-map') {
                setTimeout(() => {
                    if (leafletMap) leafletMap.invalidateSize();
                    renderFiguresOnMap(currentSortedIndex);
                    renderGallery();
                    if (currentFigureId && leafletMarkers[currentFigureId]) {
                        // Preserve the user's current zoom; only pan if the marker
                        // is outside the visible map bounds.
                        const target = leafletMarkers[currentFigureId].getLatLng();
                        if (!leafletMap.getBounds().contains(target)) {
                            leafletMap.panTo(target);
                        }
                        highlightMapFigure(currentFigureId);
                        highlightGalleryFigure(currentFigureId);
                    }
                }, 200);
            } else if (tabName === 'figure-globe') {
                // Init synchronously: the container is always display:block under the
                // cross-fade CSS, so it has dimensions immediately. Doing it now means
                // globe.gl is rendering before the opacity fade starts.
                initGlobe();
                renderGallery();
                if (currentFigureId) {
                    highlightGlobeFigure(currentFigureId);
                    // Only rotate if the current figure isn't already in view.
                    if (!getVisibleGlobeFigureKeys().includes(currentFigureId)) {
                        panGlobeTo(currentFigureId);
                    }
                    highlightGalleryFigure(currentFigureId);
                }
            }
        });
    });

    // --- Threshold slider control (allow user to slide the log threshold) ---
    try {
        // Threshold control: hidden by default. Toggle visibility with Ctrl/Cmd+Shift+L.
        const thresholdControl = document.createElement('div');
        thresholdControl.id = 'threshold-control';
        // Default hidden so it doesn't cover tab content; positioned absolutely in the header when shown.
        thresholdControl.style.display = 'none';
        thresholdControl.style.position = 'fixed';
        thresholdControl.style.top = '8px';
        thresholdControl.style.left = '50%';
        thresholdControl.style.right = 'auto';
        thresholdControl.style.transform = 'translateX(-50%)';
        thresholdControl.style.zIndex = '1200';
        thresholdControl.style.background = 'rgba(255,255,255,0.95)';
        thresholdControl.style.padding = '6px 8px';
        thresholdControl.style.borderRadius = '6px';
        thresholdControl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        thresholdControl.setAttribute('aria-hidden', 'true');

        const label = document.createElement('label');
        label.textContent = 'Log threshold:';
        label.style.fontSize = '0.9em';
        label.style.marginRight = '0.4em';
        thresholdControl.appendChild(label);

        const thresholdSlider = document.createElement('input');
        thresholdSlider.type = 'range';
        thresholdSlider.min = String(minYear);
        thresholdSlider.max = String(maxYear);
        thresholdSlider.step = '100';
        thresholdSlider.value = String(LOG_SCALE_THRESHOLD);  // read from gaerhf-colormap.js
        thresholdSlider.title = 'Slide to change log threshold (years)';
        thresholdSlider.style.verticalAlign = 'middle';
        thresholdControl.appendChild(thresholdSlider);

        const thresholdValue = document.createElement('span');
        thresholdValue.style.marginLeft = '0.5em';
        thresholdValue.style.fontSize = '0.9em';
        thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
        thresholdControl.appendChild(thresholdValue);

        const thresholdCloseBtn = document.createElement('button');
        thresholdCloseBtn.type = 'button';
        thresholdCloseBtn.textContent = 'x';
        thresholdCloseBtn.title = 'Hide log-threshold slider';
        thresholdCloseBtn.setAttribute('aria-label', 'Hide log-threshold slider');
        thresholdCloseBtn.style.marginLeft = '8px';
        thresholdCloseBtn.style.border = 'none';
        thresholdCloseBtn.style.background = 'transparent';
        thresholdCloseBtn.style.cursor = 'pointer';
        thresholdCloseBtn.style.fontSize = '1rem';
        thresholdCloseBtn.style.lineHeight = '1';
        thresholdCloseBtn.style.color = '#555';
        thresholdCloseBtn.style.padding = '0 2px';
        thresholdCloseBtn.addEventListener('click', () => {
            // Shared setter dispatches the visibility-changed event so both
            // colormap-menu checkboxes stay in sync with this close action.
            setThresholdSliderVisible(false);
        });
        thresholdControl.appendChild(thresholdCloseBtn);

        // Insert into headerContainer if available, otherwise append to document.body
        const mainTitle = document.getElementById('main-title');
        if (mainTitle) {
            mainTitle.style.position = 'relative'; // ensures absolute children position correctly if needed
            mainTitle.appendChild(thresholdControl);
        } else if (headerContainer) {
            headerContainer.appendChild(thresholdControl);
        } else {
            document.body.appendChild(thresholdControl);
        }

        function updateThresholdControlPosition() {
            const mapContainer = document.getElementById('figure-map-container');
            const globeContainer = document.getElementById('figure-globe-container');

            let anchor = null;
            if (currentTab === 'figure-globe' && globeContainer) {
                anchor = globeContainer;
            } else if (currentTab === 'figure-map' && mapContainer) {
                anchor = mapContainer;
            } else if (globeContainer && globeContainer.classList.contains('active')) {
                anchor = globeContainer;
            } else if (mapContainer && mapContainer.classList.contains('active')) {
                anchor = mapContainer;
            } else {
                anchor = mapContainer || globeContainer;
            }

            if (!anchor) {
                thresholdControl.style.top = '8px';
                return;
            }

            const anchorRect = anchor.getBoundingClientRect();
            thresholdControl.style.top = `${Math.max(8, Math.round(anchorRect.top + 8))}px`;
        }

        updateThresholdControlPosition();
        window.addEventListener('resize', updateThresholdControlPosition);
        document.addEventListener('gaerhf:threshold-visibility-changed', () => {
            if (isThresholdSliderVisible()) {
                updateThresholdControlPosition();
            }
        });
        document.addEventListener('gaerhf:threshold-value-changed', (evt) => {
            const value = Number(evt && evt.detail && evt.detail.value);
            if (!Number.isFinite(value)) return;
            thresholdSlider.value = String(value);
            thresholdValue.textContent = formatDateForDisplay(value);
        });
        tabButtons.forEach(tabButton => {
            tabButton.addEventListener('click', () => {
                requestAnimationFrame(updateThresholdControlPosition);
            });
        });

        // Toggle function and keyboard shortcut (Ctrl+Shift+L). Flows
        // through setThresholdSliderVisible() in gaerhf-colormap.js so
        // both pickers' checkboxes stay in sync via the shared event.
        function toggleThresholdControlVisibility() {
            setThresholdSliderVisible(!isThresholdSliderVisible());
        }

        // Toggle with Ctrl (Windows/Linux) OR Cmd (macOS) + Shift + L.
        // Ignore when focus is in an editable field.
        document.addEventListener('keydown', (e) => {
            try {
                const target = e.target;
                const editing = target && (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable
                );
                if (editing) return; // don't toggle while typing

                const modifier = e.ctrlKey || e.metaKey; // Ctrl or Cmd
                if (modifier && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
                    toggleThresholdControlVisibility();
                    e.preventDefault();
                }
            } catch (err) {
                // defensive: ignore errors
            }
        });

        // Live update while sliding; debounce final action (rerender map) when user stops.
        // setLogScaleThreshold() fires onColormapChange listeners so the Map markers AND the
        // Globe (markers + legend) re-render in response.
        thresholdSlider.addEventListener('input', (e) => {
            const val = Number(e.target.value);
            if (Number.isFinite(val)) {
                setLogScaleThreshold(val);
                thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
                renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
            }
            if (thresholdDebounceTimer) clearTimeout(thresholdDebounceTimer);
            thresholdDebounceTimer = setTimeout(() => {
                if (currentTab === 'figure-map') {
                    renderFiguresOnMap(currentSortedIndex);
                }
                thresholdDebounceTimer = null;
            }, 300);
        });

        thresholdSlider.addEventListener('change', (e) => {
            const val = Number(e.target.value);
            if (Number.isFinite(val)) {
                setLogScaleThreshold(val);
                thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
            }
            if (thresholdDebounceTimer) { clearTimeout(thresholdDebounceTimer); thresholdDebounceTimer = null; }
            if (currentTab === 'figure-map') renderFiguresOnMap(currentSortedIndex);
        });
    } catch (err) {
        console.warn('Could not create threshold control:', err);
    }

    // Modal interaction listeners
    const modal = document.getElementById('site-modal');
    const closeBtn = document.getElementById('modal-close-btn');
    closeSiteModal();
    if (closeBtn) closeBtn.onclick = closeSiteModal;

    window.addEventListener('pageshow', () => {
        closeSiteModal();
        closeListModal();
    });

    window.addEventListener('click', (e) => {
        if (e.target === modal) closeSiteModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSiteModal();
    });

    // List-modal listeners
    const listModal = document.getElementById('list-modal');
    const listCloseBtn = document.getElementById('list-modal-close-btn');
    if (listCloseBtn) listCloseBtn.addEventListener('click', closeListModal);
    if (listModal) {
        listModal.addEventListener('click', (e) => {
            if (e.target === listModal) closeListModal();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && listModal && !listModal.hidden) closeListModal();
    });
});

// Returns figureIds for all currently open detail windows.
function getOpenWindowFigureIds() {
    return Array.from(document.querySelectorAll('.detail-window[data-figure-id]'))
        .map(w => w.dataset.figureId)
        .filter(Boolean);
}

// Map marker highlight state machine — mirrors gaerhf-globe.js's
// _computeGlobeMarkerStyleContext / _applyGlobeMarkerStyleTo pair so the
// same four-state model (default / primary / secondary / keyword) is
// expressed once per view. The mechanism on Map is CSS-class-based: the
// `.custom-gray-marker.marker-{primary|secondary|keyword}` rules in
// style.css drive all visual state; this function only toggles classes
// and the Leaflet z-index offset.
function _computeMapMarkerStyleContext(primaryId, keywordIdsOverride) {
    const openIds = getOpenWindowFigureIds();
    // `keywordIdsOverride` lets the dropdown hover-preview show a
    // temporary highlight set without mutating the committed
    // currentKeywordHighlightIds; omit to use the committed set.
    const kwArr = keywordIdsOverride !== undefined
        ? (keywordIdsOverride || [])
        : (currentKeywordHighlightIds || []);
    return {
        primaryId,
        secondarySet: new Set(openIds.filter(id => id !== primaryId)),
        keywordSet:   new Set(kwArr),
        hasKeyword:   Array.isArray(kwArr) && kwArr.length > 0,
    };
}

function _applyMapMarkerStyleTo(figId, marker, ctx) {
    if (!marker) return;
    const el = marker.getElement && marker.getElement();
    const isPrimary   = figId === ctx.primaryId && !!ctx.primaryId;
    const isSecondary = !isPrimary && ctx.secondarySet.has(figId);
    const isKeyword   = !isPrimary && !isSecondary && ctx.hasKeyword && ctx.keywordSet.has(figId);
    // Polygon membership is the lowest-precedence highlight: a clicked
    // (primary), open (secondary), or keyword-matched marker keeps its own
    // color so "purple wins" over the red selection ring.
    const isPolygon   = !isPrimary && !isSecondary && !isKeyword &&
                        polygonSelectionActive && polygonSelectedIds.has(figId);

    if (el) {
        el.classList.toggle('marker-primary',   isPrimary);
        el.classList.toggle('marker-secondary', isSecondary);
        el.classList.toggle('marker-keyword',   isKeyword);
        el.classList.toggle('marker-polygon',   isPolygon);
    }

    marker.setZIndexOffset(
        isPrimary   ? 2000 :
        isSecondary ? 1000 :
        isKeyword   ?  900 :
        isPolygon   ?  800 :
                         1
    );
}

function _applyMapMarkerStyles(primaryId, keywordIdsOverride) {
    if (!leafletMarkers) return;
    const ctx = _computeMapMarkerStyleContext(primaryId, keywordIdsOverride);
    Object.entries(leafletMarkers).forEach(([id, m]) => _applyMapMarkerStyleTo(id, m, ctx));
}

function highlightMapFigure(figureId) {
    _applyMapMarkerStyles(figureId);
    // Shift-click pans to the primary marker (suppressed while the
    // timescale thumbs are mid-drag — Shift there means "translate range").
    if (figureId && leafletMarkers[figureId]) {
        const marker = leafletMarkers[figureId];
        if (isShiftKeyDown && !isTimescaleThumbDragging && leafletMap) {
            leafletMap.panTo(marker.getLatLng());
        }
    }
}

function highlightGalleryFigure(figureId) {
    // Clear borders from all gallery images
    document.querySelectorAll('.gallery-image').forEach(img => {
        img.style.border = '';
    });

    // Add red border to the selected figure's gallery image
    const selectedImg = document.getElementById(`gi-${figureId}`);
    if (selectedImg) {
        selectedImg.style.border = '6px solid #CC79A7';
        // Scroll to make the highlighted image visible
        selectedImg.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
}

// Keep the current primary/secondary state; only change the keyword overlay.
// `ids` is the keyword set to render right now — distinct from the committed
// `currentKeywordHighlightIds` so the dropdown can preview a different set
// on hover without changing the persistent selection.
function highlightKeywordMarkers(ids) {
    _applyMapMarkerStyles(currentFigureId, Array.from(new Set((ids || []).filter(Boolean))));
}

function highlightKeywordGalleryImages(ids) {
    // Normalize ids: dedupe, remove empties/nulls
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));

    // Clear existing keyword highlights from all gallery images
    document.querySelectorAll('.gallery-image').forEach(img => {
        try {
            img.style.boxShadow = '';
        } catch (e) {
            // ignore and continue
        }
    });

    // Apply new keyword highlights with green boxShadow
    uniqueIds.forEach((figureId) => {
        try {
            const img = document.getElementById(`gi-${figureId}`);
            if (img && figureId !== currentFigureId) {
                img.style.boxShadow = '0px 0px 6px 6px rgba(230, 159, 0, 1)';
            }
        } catch (e) {
            // ignore and continue
        }
    });
}

window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    if (hash && hash.length > 1 && figuresDict[hash.substring(1)]) {
        showFigureDetails(hash.substring(1));
    }
});

function tokenizer(input) {
    const text = (input ?? '').toString().toLowerCase();
    // Unicode-aware word boundary regex: matches any Unicode letter/number sequences
    // \p{L} = any Unicode letter, \p{N} = any Unicode number
    const wordRegex = /[\p{L}\p{N}]+/gu;
    const tokens = text.match(wordRegex) || [];
    return tokens;
}

// Fields on a figure that contribute to the keyword index.
const KEYWORD_FIELDS = ['label', 'cultureLabel', 'materialNote', 'note', 'inModernCountry'];

function makeFiguresKWDocsArray() {
    const documents_dict = {};

    Object.values(figuresDict).forEach((figure) => {
        KEYWORD_FIELDS.forEach((field) => {
            const value = figure[field];
            if (value == null) return;
            tokenizer(typeof value === 'string' ? value : String(value)).forEach((token) => {
                if (!documents_dict[token]) documents_dict[token] = new Set();
                documents_dict[token].add(figure.id);
            });
        });
    });

    const documents_array = [];
    const dict_out = {};
    Object.keys(documents_dict).forEach((doc) => {
        const idsArray = Array.from(documents_dict[doc]);
        documents_array.push({ id: doc, ids: idsArray });
        dict_out[doc] = idsArray;
    });
    return { array: documents_array, dictionary: dict_out };
}



// Reapply the current keyword highlights everywhere they appear: map markers,
// gallery thumbnails, and globe markers. Used by every code path that
// dismisses or restores the suggestions dropdown so the three views stay
// in sync without each call site repeating the trio.
function applyKeywordHighlightsEverywhere(ids) {
    const list = ids || [];
    try { highlightKeywordMarkers(list); } catch { }
    try { highlightKeywordGalleryImages(list); } catch { }
    applyGlobeKeywordHighlights(list);
}

// ** Render Keyword Search **
function renderKeywordSearch() {
    const miniSearch = new MiniSearch({
        fields: ['id'], // Fields to search in
        storeFields: ['ids'], // Fields to return in results
        searchOptions: {
            // Allows searching for partial matches, great for typeahead
            prefix: true,
            // Increase weight for matches in the title field
        }
    });

    const kwCombined = makeFiguresKWDocsArray();
    const figuresKWArray = kwCombined['array'];
    figuresKWDict = kwCombined['dictionary'];

    miniSearch.addAll(figuresKWArray);

    const searchInput = document.getElementById('search-input');
    const suggestionsList = document.getElementById('suggestions-list');
    const zoomBtn = document.getElementById('zoom-keyword-btn');
    let searchDebounceTimer = null; // debounce timer for typeahead

    function setSuggestionsVisible(visible) {
        suggestionsList.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('search-open', visible);
    }

    // Start hidden
    setSuggestionsVisible(false);

    // Handle Enter key to clear highlights when input is empty
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query.length === 0) {
                // Clear keyword highlights
                currentKeywordHighlightIds = [];
                applyKeywordHighlightsEverywhere([]);
                setSuggestionsVisible(false);
                updateZoomKeywordButtonVisibility();
            }
        }
    });

    searchInput.addEventListener('input', () => {
        // Debounce to only search after user pauses typing
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            const query = searchInput.value.trim();
            suggestionsList.innerHTML = '';
            // Restore persistent highlight when regenerating list
            applyKeywordHighlightsEverywhere(currentKeywordHighlightIds);

            if (query.length === 0) {
                setSuggestionsVisible(false);
                return;
            }

            const results = miniSearch.search(query, { prefix: true, limit: 5 });

            if (!results || results.length === 0) {
                setSuggestionsVisible(false);
                return;
            }

            results.forEach(result => {
                // MiniSearch results always carry an `id` (the keyword token).
                const kwText = result && result.id;
                if (!kwText) return;
                const li = document.createElement('li');
                li.textContent = kwText;
                li.tabIndex = 0;
                const ids = Array.isArray(figuresKWDict[kwText]) ? figuresKWDict[kwText] : [];
                // Hover preview: temporarily highlight matching markers
                li.addEventListener('mouseover', () => applyKeywordHighlightsEverywhere(ids));
                li.addEventListener('mouseout',  () => applyKeywordHighlightsEverywhere(currentKeywordHighlightIds));
                li.addEventListener('click', () => {
                    searchInput.value = kwText;
                    suggestionsList.innerHTML = '';
                    setSuggestionsVisible(false);
                    currentKeywordHighlightIds = ids;
                    applyKeywordHighlightsEverywhere(ids);
                    updateZoomKeywordButtonVisibility();
                });
                li.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') li.click();
                });
                suggestionsList.appendChild(li);
            });

            setSuggestionsVisible(true);
        }, 450); // ~0.5s debounce
    });



    // Hide suggestions when input loses focus (small delay keeps click working)
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            setSuggestionsVisible(false);
            // Restore persistent highlight when suggestions close
            applyKeywordHighlightsEverywhere(currentKeywordHighlightIds);
            updateZoomKeywordButtonVisibility();
        }, 150);
    });

    // Optional: show suggestions when input gains focus if it already has text
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length > 0 && suggestionsList.children.length > 0) {
            setSuggestionsVisible(true);
        }
        updateZoomKeywordButtonVisibility();
    });

    // Zoom button click handler
    if (zoomBtn) {
        zoomBtn.addEventListener('click', () => {
            if (currentTab === 'figure-globe') {
                if (currentKeywordHighlightIds && currentKeywordHighlightIds.length) {
                    panGlobeTo(currentKeywordHighlightIds[0]);
                }
            } else {
                zoomToKeywordHighlightedFigures();
            }
        });
    }

    // Initial visibility
    updateZoomKeywordButtonVisibility();


    // Helper: update visibility of zoom button
    function updateZoomKeywordButtonVisibility() {
        try {
            const zoomBtn = document.getElementById('zoom-keyword-btn');
            if (!zoomBtn) return;
            const hasHighlights = currentKeywordHighlightIds && currentKeywordHighlightIds.length > 0;
            const shouldShow = hasHighlights && (currentTab === 'figure-map' || currentTab === 'figure-globe');
            zoomBtn.style.display = shouldShow ? 'inline-block' : 'none';
        } catch (e) { /* ignore */ }
    }

    // Helper: zoom map to bounds of highlighted keyword figures
    function zoomToKeywordHighlightedFigures() {
        try {
            if (!leafletMap) return;
            const ids = (currentKeywordHighlightIds || []).filter(id => leafletMarkers[id]);
            if (!ids.length) return;
            const latLngs = ids.map(id => leafletMarkers[id].getLatLng()).filter(Boolean);
            if (!latLngs.length) return;
            const bounds = L.latLngBounds(latLngs);
            if (!bounds.isValid()) return;
            if (latLngs.length === 1) {
                // Single marker: choose a zoom level that gives some context
                leafletMap.setView(latLngs[0], Math.max(leafletMap.getZoom(), 6));
            } else {
                leafletMap.fitBounds(bounds, { padding: [40, 40] });
            }
        } catch (e) { /* ignore */ }
    }
}

function getVisibleInRangeFigureIds() {
    const inRange = new Set(Array.isArray(currentSortedIndex) ? currentSortedIndex : []);

    // When a polygon selection is active, the polygon set replaces the
    // viewport filter (the selection persists regardless of zoom/pan). Still
    // intersect with the date range so the timescale and polygon compose.
    if (polygonSelectionActive) {
        const ids = Array.from(polygonSelectedIds).filter(id => inRange.has(id));
        return sortFigures(ids, 'date');
    }

    let visible = [];

    if (currentTab === 'figure-globe') {
        visible = getVisibleGlobeFigureKeys() || [];
    } else if (currentTab === 'figure-map') {
        visible = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers) || [];
    }

    if (!Array.isArray(visible) || visible.length === 0) return [];

    const ids = visible.filter(id => inRange.has(id));
    return sortFigures(Array.from(new Set(ids)), 'date');
}

function renderGallery() {

    // Both tabs show only currently-visible markers.
    //  - Map: markers within the Leaflet viewport bounds.
    //  - Globe: markers within the camera-facing spherical cap (see
    //    getVisibleGlobeFigureKeys in gaerhf-globe.js).
    let figureIds = [];
    if (currentTab === 'figure-globe' || currentTab === 'figure-map') {
        figureIds = getVisibleInRangeFigureIds();
    }

    const galleryDiv = document.getElementById('gallery');
    galleryDiv.innerHTML = "";

    // Shrink thumbs once the strip is crowded, but never below 30px.
    let maxHeight = 70;
    if (figureIds.length > 25) {
        maxHeight = Math.max(30, maxHeight * (25 / figureIds.length));
    }

    figureIds.forEach(function (figureId) {
        const galleryImg = document.createElement('img');
        galleryImg.id = `gi-${figureId}`;
        galleryImg.src = thumbnailUrl(figureId);
        galleryImg.className = "gallery-image";
        galleryImg.style = `max-height:${maxHeight}px`;

        galleryImg.addEventListener('mouseover', () => {
            if (currentTab === 'figure-globe') {
                showGlobeTooltipForFigure(figureId);
            } else if (leafletMarkers[figureId]) {
                openAdaptivePopup(leafletMarkers[figureId],
                    buildHoverContent(figuresDict[figureId], { thumbnail: false }));
            }
            try { showTimescaleHoverOverlay(figureId); } catch (e) { /* ignore */ }
        });

        galleryImg.addEventListener('mouseout', () => {
            try { clearTimescaleHoverOverlay(); } catch (e) { /* ignore */ }
            if (currentTab === 'figure-globe') {
                hideGlobeTooltip();
            } else if (leafletMarkers[figureId]) {
                leafletMarkers[figureId]._hoverCloseTimer = setTimeout(() => {
                    try { leafletMarkers[figureId].closeTooltip(); } catch { }
                    leafletMarkers[figureId]._hoverCloseTimer = null;
                }, 250);
            }
        });

        galleryImg.addEventListener('click', () => {
            highlightMapFigure(figureId);
            highlightGalleryFigure(figureId);
            try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
            try { leafletMarkers[figureId] && leafletMarkers[figureId].closeTooltip(); } catch { }
            showFigureDetails(figureId, { markAsRecent: true });
        });

        galleryDiv.appendChild(galleryImg);
    });

    // Apply keyword highlights to gallery images
    try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch (e) { /* ignore */ }

}


function openListModal() {
    let ids;
    if (currentTab === 'figure-globe' || currentTab === 'figure-map') {
        ids = getVisibleInRangeFigureIds();
    } else {
        ids = currentSortedIndex || [];
    }

    const n = ids.length;
    let thumbHeight;
    if (n <= 4)       thumbHeight = 240;
    else if (n <= 9)  thumbHeight = 180;
    else if (n <= 25) thumbHeight = 130;
    else if (n <= 50) thumbHeight = 90;
    else              thumbHeight = 60;

    const grid = document.getElementById('list-modal-grid');
    grid.innerHTML = '';
    ids.forEach(figureId => {
        const fig = figuresDict[figureId];
        if (!fig) return;
        const img = document.createElement('img');
        img.className = 'list-modal-thumb';
        img.src = thumbnailUrl(figureId);
        img.alt = fig.label;
        img.title = fig.label;
        img.loading = 'lazy';
        img.style.height = thumbHeight + 'px';
        img.addEventListener('error', () => { img.style.display = 'none'; });
        img.addEventListener('click', () => {
            closeListModal();
            showFigureDetails(figureId, { markAsRecent: true });
        });
        grid.appendChild(img);
    });

    document.getElementById('list-modal-title').textContent =
        `${n} figure${n === 1 ? '' : 's'} in view`;
    document.getElementById('list-modal').hidden = false;
}

function closeListModal() {
    const m = document.getElementById('list-modal');
    if (m) m.hidden = true;
}

function renderTimescaleRangeControls(scaleDiv, minN, maxN) {
    if (!scaleDiv) return;

    const [currentStart, currentEnd] = normalizeDateRange(selectedEarliestYear, selectedLatestYear);
    selectedEarliestYear = Math.max(minN, Math.min(maxN, currentStart));
    selectedLatestYear = Math.max(minN, Math.min(maxN, currentEnd));

    const startPct = Math.max(0, Math.min(100, timelineScale(selectedEarliestYear, minN, maxN) * 100));
    const endPct = Math.max(0, Math.min(100, timelineScale(selectedLatestYear, minN, maxN) * 100));
    const sideMargin = getTimescaleSideMarginPx(scaleDiv);
    const scaleWidth = Math.max(scaleDiv.clientWidth, 1);
    const usableWidth = Math.max(scaleWidth - (sideMargin * 2), 1);
    const startX = sideMargin + (startPct / 100) * usableWidth;
    const endX = sideMargin + (endPct / 100) * usableWidth;

    const selection = document.createElement('div');
    selection.className = 'timescale-range-selection';
    selection.style.left = `${Math.min(startX, endX)}px`;
    selection.style.width = `${Math.max(endX - startX, 0)}px`;
    selection.title = `${formatDateForDisplay(selectedEarliestYear)} - ${formatDateForDisplay(selectedLatestYear)}`;
    scaleDiv.appendChild(selection);

    const startThumb = document.createElement('div');
    startThumb.className = 'timescale-range-thumb';
    startThumb.style.left = `${startX}px`;
    startThumb.style.transform = 'translateX(-50%)';
    startThumb.setAttribute('role', 'slider');
    startThumb.setAttribute('aria-label', 'Earliest date filter');
    startThumb.setAttribute('aria-valuemin', String(minN));
    startThumb.setAttribute('aria-valuemax', String(maxN));
    startThumb.setAttribute('aria-valuenow', String(selectedEarliestYear));
    startThumb.setAttribute('aria-valuetext', formatDateForDisplay(selectedEarliestYear));
    scaleDiv.appendChild(startThumb);

    const endThumb = document.createElement('div');
    endThumb.className = 'timescale-range-thumb';
    endThumb.style.left = `${endX}px`;
    endThumb.style.transform = 'translateX(-50%)';
    endThumb.setAttribute('role', 'slider');
    endThumb.setAttribute('aria-label', 'Latest date filter');
    endThumb.setAttribute('aria-valuemin', String(minN));
    endThumb.setAttribute('aria-valuemax', String(maxN));
    endThumb.setAttribute('aria-valuenow', String(selectedLatestYear));
    endThumb.setAttribute('aria-valuetext', formatDateForDisplay(selectedLatestYear));
    scaleDiv.appendChild(endThumb);

    const renderThumbPopup = (x, year) => {
        const popup = document.createElement('div');
        popup.className = 'timescale-thumb-popup';
        popup.style.left = `${x}px`;
        popup.textContent = formatDateForDisplay(year);
        scaleDiv.appendChild(popup);
    };

    const renderRangeDistancePopup = (startXPos, endXPos, startYear, endYear) => {
        const popup = document.createElement('div');
        popup.className = 'timescale-range-distance-popup';
        popup.style.left = `${(startXPos + endXPos) / 2}px`;
        const distanceYears = Math.abs(Number(endYear) - Number(startYear));
        popup.textContent = `${Math.round(distanceYears).toLocaleString()} years`;
        scaleDiv.appendChild(popup);
    };

    // Hover behaviour: hovering EITHER thumb shows the year on BOTH
    // thumbs and the range-span popup between them. A separate hint
    // tooltip ("⇧ to maintain distance") appears BENEATH the year
    // popup on the OTHER (non-hovered) thumb. Clearing removes them
    // all together.
    const HOVER_POPUP_IDS = [
        'timescale-thumb-popup-hover-start',
        'timescale-thumb-popup-hover-end',
        'timescale-thumb-popup-hover-distance',
        'timescale-thumb-popup-hover-hint',
    ];
    const clearHoverPopups = () => {
        HOVER_POPUP_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
    };
    const showHoverPopups = (hoveredBound) => {
        if (timescaleDragPopupState.active) return;
        clearHoverPopups();

        const startPopup = document.createElement('div');
        startPopup.id = 'timescale-thumb-popup-hover-start';
        startPopup.className = 'timescale-thumb-popup';
        startPopup.style.left = `${startX}px`;
        startPopup.textContent = formatDateForDisplay(selectedEarliestYear);
        scaleDiv.appendChild(startPopup);

        const endPopup = document.createElement('div');
        endPopup.id = 'timescale-thumb-popup-hover-end';
        endPopup.className = 'timescale-thumb-popup';
        endPopup.style.left = `${endX}px`;
        endPopup.textContent = formatDateForDisplay(selectedLatestYear);
        scaleDiv.appendChild(endPopup);

        // ⇧ icon (U+21E7) matches the shift-key glyph used elsewhere
        // in popups (see SHIFT_HINT_HTML).
        const otherX = hoveredBound === 'start' ? endX : startX;
        const hintPopup = document.createElement('div');
        hintPopup.id = 'timescale-thumb-popup-hover-hint';
        hintPopup.className = 'timescale-thumb-popup-hint';
        hintPopup.style.left = `${otherX}px`;
        hintPopup.innerHTML = '&#8679; to maintain distance';
        scaleDiv.appendChild(hintPopup);

        const distancePopup = document.createElement('div');
        distancePopup.id = 'timescale-thumb-popup-hover-distance';
        distancePopup.className = 'timescale-range-distance-popup';
        distancePopup.style.left = `${(startX + endX) / 2}px`;
        const distanceYears = Math.abs(Number(selectedLatestYear) - Number(selectedEarliestYear));
        distancePopup.textContent = `${Math.round(distanceYears).toLocaleString()} years`;
        scaleDiv.appendChild(distancePopup);
    };

    const parseManualYearInput = (rawValue) => {
        if (rawValue == null) return null;
        const trimmed = String(rawValue).trim();
        if (!trimmed) return Number.NaN;

        const normalized = trimmed.replace(/,/g, '').trim();
        let valuePart = normalized;
        let parsedYear;

        if (/\bBCE\b$/i.test(normalized)) {
            valuePart = normalized.replace(/\bBCE\b$/i, '').trim();
            const n = Number(valuePart);
            if (!Number.isFinite(n)) return Number.NaN;
            parsedYear = -Math.abs(n);
        } else if (/\bCE\b$/i.test(normalized)) {
            valuePart = normalized.replace(/\bCE\b$/i, '').trim();
            const n = Number(valuePart);
            if (!Number.isFinite(n)) return Number.NaN;
            parsedYear = Math.abs(n);
        } else {
            const n = Number(valuePart);
            if (!Number.isFinite(n)) return Number.NaN;
            parsedYear = n;
        }

        return Math.round(parsedYear);
    };

    const promptThumbYearInput = (bound) => {
        const isStart = bound === 'start';
        const currentYear = isStart ? selectedEarliestYear : selectedLatestYear;
        const otherYear = isStart ? selectedLatestYear : selectedEarliestYear;
        const whichLabel = isStart ? 'earliest' : 'latest';
        const entered = window.prompt(
            `Enter ${whichLabel} year (${Math.round(minN)} to ${Math.round(maxN)}). Use negative numbers for BCE or append BCE/CE.`,
            String(Math.round(currentYear))
        );
        const parsedYear = parseManualYearInput(entered);
        if (parsedYear === null) return;
        if (!Number.isFinite(parsedYear)) {
            window.alert('Enter a valid year, e.g. -12000, 12000 BCE, or 500 CE.');
            return;
        }
        if (parsedYear < minN || parsedYear > maxN) {
            window.alert(`Year must be between ${formatDateForDisplay(minN)} and ${formatDateForDisplay(maxN)}.`);
            return;
        }
        if (isStart && parsedYear > otherYear) {
            window.alert(`Earliest year cannot be later than ${formatDateForDisplay(otherYear)}.`);
            return;
        }
        if (!isStart && parsedYear < otherYear) {
            window.alert(`Latest year cannot be earlier than ${formatDateForDisplay(otherYear)}.`);
            return;
        }

        if (isStart) selectedEarliestYear = parsedYear;
        else selectedLatestYear = parsedYear;

        timescaleDragPopupState.active = false;
        timescaleDragPopupState.showStart = false;
        timescaleDragPopupState.showEnd = false;
        clearHoverPopups();
        renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
        flushDateRangeApplyNow();
    };

    if (timescaleDragPopupState.active) {
        if (timescaleDragPopupState.showStart && Number.isFinite(timescaleDragPopupState.startYear)) {
            renderThumbPopup(startX, timescaleDragPopupState.startYear);
        }
        if (timescaleDragPopupState.showEnd && Number.isFinite(timescaleDragPopupState.endYear)) {
            renderThumbPopup(endX, timescaleDragPopupState.endYear);
        }
        if (Number.isFinite(timescaleDragPopupState.startYear) && Number.isFinite(timescaleDragPopupState.endYear)) {
            renderRangeDistancePopup(startX, endX, timescaleDragPopupState.startYear, timescaleDragPopupState.endYear);
        }
    }

    const dragThumb = (bound, event) => {
        event.preventDefault();
        isTimescaleThumbDragging = true;
        clearHoverPopups();
        const dragStartRatio = Math.max(0, Math.min(1, timelineScale(selectedEarliestYear, minN, maxN)));
        const dragEndRatio = Math.max(0, Math.min(1, timelineScale(selectedLatestYear, minN, maxN)));
        const dragSpanRatio = Math.max(0, dragEndRatio - dragStartRatio);
        const rect0 = scaleDiv.getBoundingClientRect();
        const pointerStartRatio = (event.clientX - rect0.left - sideMargin) / Math.max(rect0.width - sideMargin * 2, 1);

        const move = (moveEvent) => {
            const rect = scaleDiv.getBoundingClientRect();
            if (!rect || rect.width <= 0) return;
            const localX = moveEvent.clientX - rect.left;
            const ratio = (localX - sideMargin) / Math.max(rect.width - (sideMargin * 2), 1);
            const clampedRatio = Math.max(0, Math.min(1, ratio));

            // Shift-drag: translate range by exact pointer delta from drag start.
            // Physical pixel distance between thumbs stays constant; year span
            // changes naturally as the range crosses log/linear regions.
            if (moveEvent.shiftKey || event.shiftKey) {
                const usableWidth = Math.max(rect.width - sideMargin * 2, 1);
                const delta = (moveEvent.clientX - rect.left - sideMargin) / usableWidth - pointerStartRatio;
                let startRatio = dragStartRatio + delta;
                let endRatio   = dragEndRatio   + delta;

                if (startRatio < 0) {
                    endRatio += -startRatio;
                    startRatio = 0;
                }
                if (endRatio > 1) {
                    startRatio -= (endRatio - 1);
                    endRatio = 1;
                }

                startRatio = Math.max(0, Math.min(1, startRatio));
                endRatio = Math.max(0, Math.min(1, endRatio));

                const translatedStartYear = scaleToDate(startRatio, minN, maxN);
                const translatedEndYear = scaleToDate(endRatio, minN, maxN);
                selectedEarliestYear = Math.min(translatedStartYear, translatedEndYear);
                selectedLatestYear = Math.max(translatedStartYear, translatedEndYear);
                timescaleDragPopupState.active = true;
                timescaleDragPopupState.showStart = true;
                timescaleDragPopupState.showEnd = true;
                timescaleDragPopupState.startYear = selectedEarliestYear;
                timescaleDragPopupState.endYear = selectedLatestYear;
            } else {
                const candidateYear = scaleToDate(clampedRatio, minN, maxN);
                if (bound === 'start') {
                    selectedEarliestYear = Math.min(candidateYear, selectedLatestYear);
                    timescaleDragPopupState.active = true;
                    timescaleDragPopupState.showStart = true;
                    timescaleDragPopupState.showEnd = false;
                    timescaleDragPopupState.startYear = selectedEarliestYear;
                    timescaleDragPopupState.endYear = selectedLatestYear;
                } else {
                    selectedLatestYear = Math.max(candidateYear, selectedEarliestYear);
                    timescaleDragPopupState.active = true;
                    timescaleDragPopupState.showStart = false;
                    timescaleDragPopupState.showEnd = true;
                    timescaleDragPopupState.startYear = selectedEarliestYear;
                    timescaleDragPopupState.endYear = selectedLatestYear;
                }
            }

            renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
            scheduleDateRangeApply();
        };

        const end = () => {
            isTimescaleThumbDragging = false;
            timescaleDragPopupState.active = false;
            timescaleDragPopupState.showStart = false;
            timescaleDragPopupState.showEnd = false;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
            flushDateRangeApplyNow();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end, { once: true });
        window.addEventListener('pointercancel', end, { once: true });
    };

    startThumb.addEventListener('pointerdown', (event) => {
        if (event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            promptThumbYearInput('start');
            return;
        }
        dragThumb('start', event);
    });
    endThumb.addEventListener('pointerdown', (event) => {
        if (event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            promptThumbYearInput('end');
            return;
        }
        dragThumb('end', event);
    });
    startThumb.addEventListener('mouseenter', () => showHoverPopups('start'));
    startThumb.addEventListener('mouseleave', clearHoverPopups);
    startThumb.addEventListener('focus',      () => showHoverPopups('start'));
    startThumb.addEventListener('blur',       clearHoverPopups);
    endThumb.addEventListener('mouseenter',   () => showHoverPopups('end'));
    endThumb.addEventListener('mouseleave',   clearHoverPopups);
    endThumb.addEventListener('focus',        () => showHoverPopups('end'));
    endThumb.addEventListener('blur',         clearHoverPopups);
}


function renderFiguresAsTimescale(minDate, maxDate, currentSortedIndex) {
    const scaleDiv = document.getElementById('figure-timescale');
    if (!scaleDiv) return;
    scaleDiv.innerHTML = '';

    // Coerce numeric dates and validate
    const minN = Number(minDate);
    const maxN = Number(maxDate);
    if (!isFinite(minN) || !isFinite(maxN) || minN === maxN) {
        // Nothing sensible to render
        return;
    }

    const sideMargin = getTimescaleSideMarginPx(scaleDiv);
    const usableWidth = Math.max(scaleDiv.clientWidth - (sideMargin * 2), 1);

    // Create gradient bar. If the LOG_SCALE_THRESHOLD lies inside the range,
    // show a subtle mid-stop so users can see the visual split.
    const bar = document.createElement('div');
    bar.style.width = `${usableWidth}px`;
    bar.style.height = '16px';
    bar.style.position = 'absolute';
    bar.style.bottom = '4px'; // 4px from bottom of container
    bar.style.left = `${sideMargin}px`;
    // Store the numeric timescale range on the bar so overlay helpers can use the
    // exact same coordinate space (prevents hover vs selected mismatch).
    try {
        bar.dataset.timescaleMin = String(minN);
        bar.dataset.timescaleMax = String(maxN);
    } catch (e) { /* ignore if dataset not writable */ }

    // Compute threshold position, but be defensive: timelineScale may still misbehave
    let threshPos = timelineScale(LOG_SCALE_THRESHOLD, minN, maxN);
    if (!isFinite(threshPos)) {
        // fallback to linear interpolation of the threshold within [minN, maxN]
        threshPos = (LOG_SCALE_THRESHOLD - minN) / (maxN - minN);
    }
    // clamp
    threshPos = Math.max(0, Math.min(1, threshPos));

    // Scale-axis bar: position t along the bar = scale t. The leftmost
    // 15% (LOG_REGION_PROPORTION) renders everything BEFORE
    // LOG_SCALE_THRESHOLD; the remaining 85% renders everything after.
    // Tick labels are placed via timelineScale, so the threshold's
    // label sits exactly at the 15% boundary. As the threshold slider
    // moves, labels reposition along the bar while the bar's color
    // partition stays 15% / 85%.
    const ramp = getActiveColormap();
    const stops = 80;
    const gradStops = [];
    for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        gradStops.push(`${ramp.scaleToColor(t)} ${(t * 100).toFixed(3)}%`);
    }
    const grad = `linear-gradient(to right, ${gradStops.join(', ')})`;
    bar.style.backgroundImage = grad;
    bar.style.background = grad;
    scaleDiv.appendChild(bar);

    // --- Tick generation ---
    const ticks = [];
    ticks.push(minN);

    // If range crosses the log threshold, add a log-midpoint and the threshold tick
    if (minN < LOG_SCALE_THRESHOLD && maxN > LOG_SCALE_THRESHOLD) {
        const logMin = Math.log(Math.abs(minN - LOG_SCALE_THRESHOLD) + 1);
        const logThresh = Math.log(1); // 0 -> log(1) = 0
        const logHalf = Math.exp((logMin + logThresh) / 2) - 1 + LOG_SCALE_THRESHOLD;
        ticks.push(Math.round(logHalf));
        ticks.push(LOG_SCALE_THRESHOLD);
    }

    // Adaptive linear ticks for the post-threshold region
    const linearStart = Math.max(LOG_SCALE_THRESHOLD + 1, minN);
    const linearRange = Math.max(0, maxN - linearStart);
    let stepAfter = 2000;
    if (linearRange > 0) {
        // choose roughly 5-8 ticks for the linear region
        let approx = linearRange / 6;
        // round approx to a sensible magnitude (100, 500, 1000, etc.)
        const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(approx, 1)))));
        const roundTo = magnitude >= 1000 ? 1000 : (magnitude >= 100 ? 100 : 10);
        stepAfter = Math.max(100, Math.round(approx / roundTo) * roundTo);
        if (stepAfter === 0) stepAfter = 1000;
    }

    // Generate linear ticks after threshold (skip those <= threshold)
    if (stepAfter > 0) {
        // start at the first multiple of stepAfter greater than LOG_SCALE_THRESHOLD
        let start = Math.ceil((LOG_SCALE_THRESHOLD + 1) / stepAfter) * stepAfter;
        for (let y = start; y < maxN; y += stepAfter) {
            if (y > LOG_SCALE_THRESHOLD && y < maxN) ticks.push(y);
            // safety guard to avoid infinite loops
            if (ticks.length > 200) break;
        }
    }

    ticks.push(maxN);

    // Unique & sorted
    const uniqueTicks = Array.from(new Set(ticks.map(Number))).filter(v => isFinite(v)).sort((a, b) => a - b);

    // Render ticks, skipping labels that would collide
    let lastLabelPos = -Infinity;
    const minLabelGapPct = 4; // minimum percent separation between labels

    uniqueTicks.forEach((year, i) => {
        const p = timelineScale(year, minN, maxN);
        if (!isFinite(p) || Number.isNaN(p)) return;
        let percent = p * 100;
        // clamp
        percent = Math.max(0, Math.min(100, percent));

        // Tick line
        const tick = document.createElement('div');
        tick.style.position = 'absolute';
        tick.style.left = `${percent}%`;
        tick.style.bottom = '4px'; // Align with bar bottom
        tick.style.width = '1px';
        tick.style.height = '16px';
        tick.style.background = '#222';
        tick.style.transform = 'translateX(-0.5px)';
        bar.appendChild(tick);

        // Label (may be skipped if too close)
        const labelNeeded = (i === 0) || (i === uniqueTicks.length - 1) || ((percent - lastLabelPos) >= minLabelGapPct);
        if (labelNeeded) {
            const label = document.createElement('div');
            label.style.position = 'absolute';
            label.style.left = `${sideMargin + (percent / 100) * usableWidth}px`;
            label.style.top = '2px'; // Position labels at top of container
            label.style.fontSize = '11px';
            label.style.color = '#222';
            label.textContent = formatDateForDisplay(year);

            if (i === 0) {
                label.style.transform = 'translateX(0)';
                label.style.textAlign = 'left';
            } else if (i === uniqueTicks.length - 1) {
                label.style.transform = 'translateX(-100%)';
                label.style.textAlign = 'right';
            } else {
                label.style.transform = 'translateX(-50%)';
                label.style.textAlign = 'center';
            }

            scaleDiv.appendChild(label); // Append to scaleDiv, not bar
            lastLabelPos = percent;
        }
    });

    renderTimescaleRangeControls(scaleDiv, minN, maxN);

    // --- Selected-figure overlay (render via shared helper) ---
    try {
        // Use the shared overlay helper so hovered and selected overlays share behaviour/style logic
        if (currentFigureId) {
            // selection: coordinated purple to match current figure styling
            showTimescaleOverlay(bar, currentFigureId, '#CC79A7', 'timescale-selected', minN, maxN);
        }
    } catch (err) {
        console.warn('Could not render selected-figure overlay on timescale:', err);
    }
}

// Repaints existing markers using the active colormap. Iterates all live
// markers in leafletMarkers — no figure-array filter needed since the
// color domain is fixed and we only touch markers that already exist.
function updateMarkerColors() {
    Object.entries(leafletMarkers).forEach(([id, marker]) => {
        const figure = figuresDict[id];
        if (!figure) return;
        _paintMapMarker(marker, _resolveMarkerColors(figure));
    });
}

// --- Timescale hover overlay helpers (blue) ---
function getTimescaleRange(ids) {
    const source = Array.isArray(ids) && ids.length > 0
        ? ids
        : (Array.isArray(currentSortedIndex) && currentSortedIndex.length > 0
            ? currentSortedIndex
            : Object.keys(figuresDict || {}));
    const valid = source.map(id => figuresDict[id]).filter(f => f && getFigureStart(f) != null);
    if (!valid || valid.length === 0) return [minYear, maxYear];
    const minN = Math.min(...valid.map(getFigureStart));
    const maxN = Math.max(...valid.map(getFigureEnd));
    if (!isFinite(minN) || !isFinite(maxN) || minN === maxN) return [minYear, maxYear];
    return [minN, maxN];
}

// Shared timescale overlay utilities -------------------------------------------------
function hexToRgba(hex, alpha) {
    try {
        if (!hex) return null;
        hex = String(hex).trim();
        // Handle rgb(...) input by injecting alpha
        if (hex.startsWith('rgb(')) {
            const parts = hex.replace(/rgba?\(/, '').replace(')', '').split(',').map(s => s.trim());
            if (parts.length >= 3) {
                return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
            }
        }
        if (hex.startsWith('#')) {
            const h = hex.slice(1);
            if (h.length === 3) {
                const r = parseInt(h[0] + h[0], 16);
                const g = parseInt(h[1] + h[1], 16);
                const b = parseInt(h[2] + h[2], 16);
                return `rgba(${r},${g},${b},${alpha})`;
            } else if (h.length === 6) {
                const r = parseInt(h.slice(0, 2), 16);
                const g = parseInt(h.slice(2, 4), 16);
                const b = parseInt(h.slice(4, 6), 16);
                return `rgba(${r},${g},${b},${alpha})`;
            }
        }
        // fallback: attempt to use the color string directly (may not support alpha)
        return hex;
    } catch (e) {
        return hex;
    }
}

function clearTimescaleOverlay(prefix) {
    try {
        const overlayId = `${prefix}-overlay`;
        const lineId = `${prefix}-line`;
        const existing = document.getElementById(overlayId);
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        const existingLine = document.getElementById(lineId);
        if (existingLine && existingLine.parentNode) existingLine.parentNode.removeChild(existingLine);
    } catch (err) {
        // ignore
    }
}

function showTimescaleOverlay(bar, figureId, color, prefix, minN, maxN) {
    try {
        if (!bar || !figureId || !figuresDict || !figuresDict[figureId]) return;

        // If caller didn't provide min/max, prefer the range stored on the bar element
        // (set by renderFiguresAsTimescale). Fall back to the computed range.
        if (!isFinite(minN) || !isFinite(maxN)) {
            let dmin = NaN, dmax = NaN;
            try {
                if (bar && bar.dataset) {
                    dmin = Number(bar.dataset.timescaleMin);
                    dmax = Number(bar.dataset.timescaleMax);
                }
            } catch (e) { /* ignore */ }
            if (isFinite(dmin) && isFinite(dmax) && dmin !== dmax) {
                minN = dmin; maxN = dmax;
            } else {
                const rng = getTimescaleRange();
                minN = rng[0]; maxN = rng[1];
            }
        }

        let figStart = getFigureStart(figuresDict[figureId]);
        let figEnd = getFigureEnd(figuresDict[figureId]);
        if (figStart == null || figEnd == null) return;
        figStart = Number(figStart); figEnd = Number(figEnd);
        if (!isFinite(figStart) || !isFinite(figEnd)) return;
        if (figEnd < figStart) { const t = figStart; figStart = figEnd; figEnd = t; }

        const clampedStart = Math.max(minN, Math.min(maxN, figStart));
        const clampedEnd = Math.max(minN, Math.min(maxN, figEnd));

        let s = timelineScale(clampedStart, minN, maxN);
        let e = timelineScale(clampedEnd, minN, maxN);
        if (!isFinite(s) || Number.isNaN(s)) s = (clampedStart - minN) / (maxN - minN);
        if (!isFinite(e) || Number.isNaN(e)) e = (clampedEnd - minN) / (maxN - minN);

        let startPct = Math.max(0, Math.min(1, s)) * 100;
        let endPct = Math.max(0, Math.min(1, e)) * 100;
        if (endPct < startPct) { const t = startPct; startPct = endPct; endPct = t; }
        const widthPct = Math.max(0, endPct - startPct);

        // cleanup previous matching overlay
        clearTimescaleOverlay(prefix);

        const minVisiblePct = 0.5;
        const lineId = `${prefix}-line`;
        const overlayId = `${prefix}-overlay`;
        if (widthPct <= minVisiblePct) {
            const line = document.createElement('div');
            line.id = lineId;
            line.style.position = 'absolute';
            const atLeftEdge = startPct <= minVisiblePct;
            if (atLeftEdge) {
                line.style.left = `0%`;
                line.style.width = '5px';
                line.style.transform = 'translateX(0)';
            } else {
                line.style.left = `${startPct}%`;
                line.style.width = '3px';
                line.style.transform = 'translateX(-1.5px)';
            }
            line.style.top = '0';
            line.style.height = '16px';
            line.style.background = color;
            line.style.zIndex = '1300';
            bar.appendChild(line);
        } else {
            const span = document.createElement('div');
            span.id = overlayId;
            span.style.position = 'absolute';
            span.style.left = `${startPct}%`;
            span.style.top = '0';
            span.style.width = `${widthPct}%`;
            span.style.height = '16px';
            const fill = hexToRgba(color, 0.5) || color;
            const border = hexToRgba(color, 0.6) || color;
            span.style.background = fill;
            span.style.border = `2px solid ${border}`;
            span.style.boxSizing = 'border-box';
            span.style.zIndex = '1250';
            bar.appendChild(span);
        }
    } catch (err) {
        console.warn('Could not render timescale overlay:', err);
    }
}

// End shared overlay utilities -----------------------------------------------------

function clearTimescaleHoverOverlay() {
    clearTimescaleOverlay('timescale-hover');
}

function showTimescaleHoverOverlay(figureId) {
    try {
        if (!figureId) return;
        const scaleDiv = document.getElementById('figure-timescale');
        if (!scaleDiv) return;
        const bar = scaleDiv.querySelector('div');
        if (!bar) return;
        showTimescaleOverlay(bar, figureId, '#0f96f0', 'timescale-hover');
    } catch (err) {
        console.warn('Could not render hover overlay:', err);
    }
}
