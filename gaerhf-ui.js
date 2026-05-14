const turtleUrl = 'gaerhf.ttl';
const figureListDiv = document.getElementById('figure-list');
const headerContainer = document.getElementById('header-container');

const minYear = -50000; // Minimum year
const maxYear = 1500;     // Maximum year

const SHIFT_HINT_HTML = `<div class="popup-hint">&#8679; Shift: open new window</div>`;

// thumbnailUrl, largeUrl, isEmbeddable, EMBEDDABLE_HOSTS, openSiteModal, closeSiteModal,
// formatDateForDisplay, getWikimediaImageUrl, probeImageExists, getImageSources,
// renderFigureHeader, renderFigureMetadata, renderFigureImage,
// dragElement, initResizers, createDetailWindowShell,
// getActiveWindow, _setActiveWindowBase
// — all provided by gaerhf-detail.js (loaded before this script in index.html).

// Marker icon factory — single source of truth for marker size, shape, and border.
function makeMarkerIcon(color) {
    return L.divIcon({
        className: 'custom-gray-marker',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
        tooltipAnchor: [0, -5],  // tip points to the top-center of the 10px marker
        html: `<div style="width:10px;height:10px;box-sizing:border-box;transform-origin:center center;background:${color};border-radius:50%;border:1.5px solid #222;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>`
    });
}

// Check for 'play' CGI parameter in the URL
const urlParams = new URLSearchParams(window.location.search);
const playParam = urlParams.get('play');
const viewParam = urlParams.get('view')

// Initialize the figures dictionary
let figuresDict = {};
let currentSortedIndex = [];
let figuresKWDict = {}; // keyword-to-IDs index, populated by initKeywordSearch
let tp;

// Playback variables
let playInterval = null;
let playIndex = 0;

let currentFigureId = null;
let currentTab = "figure-map";

let leafletMap = null;
let leafletMarkers = {}; // Place this at the top level

let thresholdDebounceTimer = null;
let isShiftKeyDown = false;
let currentKeywordHighlightIds = [];

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

function markerLabelContent(figureId) {
    const f = figuresDict[figureId];
    return f ? buildPopupContent(f.label || f.id) : '';
}

function buildPopupContent(label, options = {}) {
    const { figureId = null, showImage = false, showHint = false } = options;
    const imageHtml = showImage && figureId
        ? `<div class="popup-thumb-frame"><img class="popup-thumb" src="${thumbnailUrl(figureId)}" loading="lazy" alt=""></div>`
        : '';

    return `
        <div class="popup-card">
            <div class="popup-title">${label}</div>
            ${imageHtml}
            ${showHint ? SHIFT_HINT_HTML : ''}
        </div>
    `;
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

                processedDict[shortId] = {
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

    return Object.keys(figuresDict).filter(figureId => {
        const figure = figuresDict[figureId];
        if (!figure) {
            console.warn("Figure not found for ID:", figureId);
            return false;
        }

        const figureStartDate = getFigureStart(figure);
        const figureEndDate = getFigureEnd(figure);

        if (figureStartDate === undefined && figureEndDate === undefined) {
            console.warn("Figure has no valid dates:", figureId, figure);
            return false;
        }

        return (
            (figureStartDate >= startYear && figureStartDate <= endYear) || // Start date is within range
            (figureEndDate >= startYear && figureEndDate <= endYear) ||     // End date is within range
            (figureStartDate <= startYear && figureEndDate >= endYear)      // Range overlaps the selected range
        );
    });
}

async function renderFiguresAsList(figuresArray) {
    figureListDiv.innerHTML = ''; // Clear the list container

    if (!figuresArray || figuresArray.length === 0) {
        // Display a message if no figures are found
        figureListDiv.textContent = 'No human figures or groups found.';
        return;
    }

    for (const figureId of figuresArray) {
        const figure = figuresDict[figureId];
        const figureItem = document.createElement('div');
        figureItem.setAttribute('id', `list-${figure.id}`);
        figureItem.classList.add('figure-item');
        figureItem.style.display = 'flex';
        figureItem.style.alignItems = 'center';

        const thumbnailImg = document.createElement('img');
        thumbnailImg.src = thumbnailUrl(figureId);
        thumbnailImg.loading = "lazy";
        thumbnailImg.style.width = '50px';
        thumbnailImg.style.height = 'auto';
        thumbnailImg.style.marginRight = '10px';

        figureItem.appendChild(thumbnailImg);

        // }

        const textContainer = document.createElement('div');

        // Show date range if available, or approximate date
        if (figure.date !== null) {
            const dateDiv = document.createElement('div');
            dateDiv.classList.add('date-info');
            dateDiv.style.fontSize = '0.8em';
            dateDiv.style.marginBottom = '.4em';
            dateDiv.textContent = `${formatDateForDisplay(figure.date)}`;
            textContainer.appendChild(dateDiv);
        } else if (figure.earliestDate !== null && figure.latestDate !== null) {
            const dateDiv = document.createElement('div');
            dateDiv.classList.add('date-info');
            dateDiv.style.fontSize = '0.8em';
            dateDiv.style.marginBottom = '.4em';
            dateDiv.textContent = `${formatDateForDisplay(figure.earliestDate)} - ${formatDateForDisplay(figure.latestDate)}`;
            textContainer.appendChild(dateDiv);
        } else if (figure.approximateDate !== null) {
            const dateDiv = document.createElement('div');
            dateDiv.classList.add('date-info');
            dateDiv.style.fontSize = '0.8em';
            dateDiv.style.marginBottom = '.4em';
            dateDiv.textContent = `${formatDateForDisplay(figure.approximateDate)}`;
            textContainer.appendChild(dateDiv);
        }

        const labelSpan = document.createElement('span');
        labelSpan.textContent = figure.label || figure.id;
        textContainer.appendChild(labelSpan);

        if (figure.cultureLabel || figure.culture) {
            const cultureDiv = document.createElement('div');
            cultureDiv.classList.add('culture-info');
            cultureDiv.style.fontSize = '0.8em';
            cultureDiv.textContent = `${figure.cultureLabel || figure.culture}`;
            textContainer.appendChild(cultureDiv);
        }

        if (figure.materialNote) {
            const materialDiv = document.createElement('div');
            materialDiv.classList.add('material-info');
            materialDiv.style.fontSize = '0.8em';
            materialDiv.textContent = `${figure.materialNote}`;
            textContainer.appendChild(materialDiv);
        }

        if (figure.inModernCountry) {
            const countryDiv = document.createElement('div');
            countryDiv.classList.add('country-info');
            countryDiv.style.fontSize = '0.8em';
            countryDiv.textContent = `${figure.inModernCountry}`;
            textContainer.appendChild(countryDiv);
        }

        figureItem.appendChild(textContainer);
        figureItem.addEventListener('click', () => {
            showFigureDetails(figure.id);
            highlightListFigure(figure.id);
        });
        figureListDiv.appendChild(figureItem);
    }

    // --- Add this block at the end ---
    // If there's a hash in the URL, scroll to that figure
    const hash = window.location.hash;
    if (hash && hash.length > 1) {
        const figureId = hash.substring(1);
        if (document.getElementById(`list-${figureId}`)) {
            scrollToListFigure(figureId);
        }
    }
    // --- End block ---
}

// Timeline display settings
let LOG_SCALE_THRESHOLD = -4000; // Dates before this will be compressed logarithmically (user-adjustable)
const LOG_SCALE_FACTOR = 4;         // Higher = more compression for early dates
const LOG_REGION_PROPORTION = 0.15;  // 0.4 = 40% of width for log region, adjust as needed

function timelineScale(date, minDate, maxDate) {
    // Defensive conversion
    const d = Number(date);
    const minN = Number(minDate);
    const maxN = Number(maxDate);
    if (!isFinite(d) || !isFinite(minN) || !isFinite(maxN) || minN === maxN) {
        // fallback to a simple clamp in case of bad inputs
        if (!isFinite(d) || !isFinite(minN) || !isFinite(maxN)) return 0.5;
        return 0; // degenerate range
    }

    try {
        // If all dates are after the threshold, use linear scaling only
        if (minN >= LOG_SCALE_THRESHOLD) {
            return (d - minN) / (maxN - minN);
        }

        // If all dates are before the threshold, use log-only scaling with optional compression
        if (maxN < LOG_SCALE_THRESHOLD) {
            const logMin = Math.log(Math.abs(minN - LOG_SCALE_THRESHOLD) + 1);
            const logMax = Math.log(Math.abs(maxN - LOG_SCALE_THRESHOLD) + 1);
            const logVal = Math.log(Math.abs(d - LOG_SCALE_THRESHOLD) + 1);
            const denom = (logMax - logMin);
            if (!isFinite(denom) || denom === 0) {
                // fallback to linear inside the available span
                return Math.max(0, Math.min(1, (d - minN) / (maxN - minN)));
            }
            let normalized = (logVal - logMin) / denom;
            normalized = Math.max(0, Math.min(1, normalized));
            // Apply power-based compression inside the log-space
            return Math.pow(normalized, LOG_SCALE_FACTOR);
        }

        // Hybrid case: allocate LOG_REGION_PROPORTION of the width to the compressed log region,
        // and the remainder to linear scaling for recent dates.
        if (d < LOG_SCALE_THRESHOLD) {
            // Log region: normalize in log-space to [0,1], then compress and scale into the reserved proportion
            const logMin = Math.log(Math.abs(minN - LOG_SCALE_THRESHOLD) + 1);
            const logMax = Math.log(1); // at threshold -> log(1) == 0
            const logVal = Math.log(Math.abs(d - LOG_SCALE_THRESHOLD) + 1);
            const denom = (logMax - logMin);
            if (!isFinite(denom) || denom === 0) {
                // fallback: map proportionally into the log region based on distance
                const fallback = Math.max(0, Math.min(1, (d - minN) / (LOG_SCALE_THRESHOLD - minN)));
                return Math.pow(fallback, LOG_SCALE_FACTOR) * LOG_REGION_PROPORTION;
            }
            let normalized = (logVal - logMin) / denom;
            normalized = Math.max(0, Math.min(1, normalized));
            const compressed = Math.pow(normalized, LOG_SCALE_FACTOR);
            return compressed * LOG_REGION_PROPORTION;
        } else {
            // Linear region: map to [LOG_REGION_PROPORTION, 1]
            const linearMin = LOG_SCALE_THRESHOLD;
            const linearMax = maxN;
            if (linearMax === linearMin) return 1; // avoid division by zero
            return LOG_REGION_PROPORTION + ((d - linearMin) / (linearMax - linearMin)) * (1 - LOG_REGION_PROPORTION);
        }
    } catch (err) {
        // Unexpected error: fallback to simple linear mapping
        return Math.max(0, Math.min(1, (d - minN) / (maxN - minN)));
    }
}

async function renderFiguresAsTimeline(figuresDisplayIndex) {
    const timelineContainer = document.getElementById('figure-timeline');
    timelineContainer.innerHTML = ''; // Clear any existing content

    if (!figuresDisplayIndex || figuresDisplayIndex.length === 0) {
        timelineContainer.textContent = 'No human figures or groups found.';
        return;
    }

    const [earliestDate, latestDate] = getTimescaleRange(figuresDisplayIndex);

    if (earliestDate === latestDate) {
        timelineContainer.textContent = 'No valid dates found for the selected range.';
        return;
    }

    // Get the width of the timeline container for label positioning
    const containerWidth = timelineContainer.offsetWidth;

    let hoverTimeout = null;

    figuresDisplayIndex.forEach((figureId, index) => {
        const figure = figuresDict[figureId];
        const startDate = getFigureStart(figure);
        const endDate = getFigureEnd(figure);

        if (startDate === null || endDate === null) {
            return; // Skip figures with no valid dates
        }

        // Scale both start and end to [0, 1]
        const scaledStart = timelineScale(startDate, earliestDate, latestDate);
        const scaledEnd = timelineScale(endDate, earliestDate, latestDate);

        // Convert to percent for CSS
        const startPercent = scaledStart * 100;
        const endPercent = scaledEnd * 100;

        const figureDiv = document.createElement('div');
        figureDiv.setAttribute('id', `timeline-${figureId}`);
        figureDiv.classList.add('timeline-figure');
        figureDiv.style.position = 'absolute';
        figureDiv.style.left = `${startPercent}%`;
        figureDiv.style.width = `${Math.max(endPercent - startPercent, 0.5)}%`;
        figureDiv.style.top = `${index * 20}px`; // Use 20px or more for better spacing
        figureDiv.title = `${figure.label || figure.id}: ${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}`;
        figureDiv.addEventListener('click', () => {
            showFigureDetails(figureId);
        });
        figureDiv.dataset.figureId = figureId;

        figureDiv.addEventListener('mouseover', () => {
            hoverTimeout = setTimeout(() => {
                document.querySelectorAll('.timeline-figure.highlighted').forEach(div => {
                    div.classList.remove('highlighted');
                });
                showFigureDetails(figureId);
            }, 250);
        });

        figureDiv.addEventListener('mouseout', () => {
            clearTimeout(hoverTimeout);
        });

        // Add country label if available
        if (figure.inModernCountry) {
            const labelDiv = document.createElement('div');
            labelDiv.className = 'timeline-country-label';
            labelDiv.textContent = figure.inModernCountry;

            // Calculate the pixel position of the bar's right edge
            // Use getBoundingClientRect after appending, or estimate based on percent
            // We'll estimate here for simplicity
            // If the bar is in the right 25% of the timeline, put label to the left, else to the right
            const barRightPercent = endPercent;
            if (barRightPercent > 75) {
                labelDiv.classList.add('left');
            } else {
                labelDiv.classList.add('right');
            }
            figureDiv.appendChild(labelDiv);
        }

        timelineContainer.appendChild(figureDiv);
    });

    // Optional: set container to relative positioning for absolute bars
    timelineContainer.style.position = 'relative';
    timelineContainer.style.height = `${figuresDisplayIndex.length * 20 + 20}px`;

    // (tick rendering belongs in the timescale renderer; nothing more to do here)
}

function initializeMap() {
    leafletMap = L.map('figure-map', {
        worldCopyJump: true,
        keyboard: false,  // CRITICAL: Disable Leaflet's keyboard handler completely
        boxZoom: false    // Shift+drag box-zoom conflicts with Shift+click for new windows
    }).setView([20, 15], 2); // World view
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap);
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
    leafletMap.on('zoomend', function () {
        renderGallery();
        highlightGalleryFigure(currentFigureId);
        try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch (e) { /* ignore */ }
        try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
    });
    leafletMap.on('moveend', function () {
        renderGallery();
        highlightGalleryFigure(currentFigureId);
        try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch (e) { /* ignore */ }
        try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
    });
}

function renderFiguresOnMap(figuresArray) {
    if (!leafletMap) initializeMap();

    // We'll update markers in-place where possible to preserve highlight styles
    // Do NOT recreate all markers — update existing markers' background color, create missing ones,
    // and remove markers that are no longer needed. This avoids losing border/boxShadow highlights.

    // Find min/max date for scaling
    const [minDate, maxDate] = getTimescaleRange(figuresArray);

    // Update existing markers in-place where possible (to preserve highlight borders/shadows),
    // create markers for figures that don't yet have one, and remove any leftover markers
    // that are not in the current figuresArray.
    const toKeep = new Set();

    figuresArray.forEach(figureId => {
        const figure = figuresDict[figureId];
        if (!figure || !figure.representativeLatLongPoint) return;

        const [lat, lng] = figure.representativeLatLongPoint;
        const date = getFigureStart(figure);
        let scale = 0.5;
        if (date !== null && !isNaN(date)) {
            scale = timelineScale(date, minDate, maxDate);
        }
        const gray = Math.round(scale * 255);
        const color = `rgb(${gray},${gray},${gray})`;

        // If a marker already exists for this figure, update its inner div background color
        // and keep it. This preserves styles like border and boxShadow applied by highlight
        // functions.
        if (leafletMarkers[figureId]) {
            const existingMarker = leafletMarkers[figureId];
            const el = existingMarker.getElement && existingMarker.getElement();
            if (el) {
                const inner = el.querySelector && el.querySelector('div');
                if (inner) {
                    inner.style.backgroundColor = color;
                }
            } else {
                // If element isn't available, ensure the icon is set so it will render when visible
                existingMarker.setIcon(makeMarkerIcon(color));
            }
            toKeep.add(figureId);
            return;
        }

        // Otherwise create a new marker (first time seen)
        const icon = makeMarkerIcon(color);

        const marker = L.marker([lat, lng], { icon }).addTo(leafletMap);
        marker.on('click', () => {
            highlightMapFigure(figureId);
            highlightGalleryFigure(figureId);
            showFigureDetails(figureId);
            clickContent = buildPopupContent(figure.label || figure.id);
            openAdaptivePopup(marker, clickContent);
        });
        marker.on('mouseover', () => {
            mouseOverContent = buildPopupContent(figure.label || figure.id, {
                figureId: figure.id,
                showImage: true,
                showHint: true,
            });
            openAdaptivePopup(marker, mouseOverContent);
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

    // Reapply selected figure highlight if present (we preserved boxShadow for keyword highlights
    // by updating colors in-place, but ensure the selected figure has its border applied)
    try {
        if (currentFigureId && leafletMarkers[currentFigureId]) {
            highlightMapFigure(currentFigureId);
            highlightGalleryFigure(currentFigureId)
        }
    } catch (err) {
        // ignore
    }

}

async function showFigureDetails(figureId, { markAsRecent = false } = {}) {
    const figure = figuresDict[figureId];
    if (!figure) return;

    const targetWindow = (isShiftKeyDown || !getActiveWindow()) ? createDetailWindow(figureId) : getActiveWindow();
    targetWindow.dataset.figureId = figureId;

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

    setActiveWindow(targetWindow);
    try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { }
}

function createDetailWindow(figureId) {
    const count   = document.querySelectorAll('.detail-window').length;
    const _fig    = figuresDict[figureId];
    const _lng    = _fig && _fig.representativeLatLongPoint ? _fig.representativeLatLongPoint[1] : null;
    const _placeLeft = _lng !== null && _lng >= 0; // eastern hemisphere → left side keeps marker visible

    const win = createDetailWindowShell({
        onClose: () => {
            if (!getActiveWindow()) currentFigureId = null;
            highlightMapFigure(currentFigureId);
            if (typeof highlightGlobeFigure === 'function') highlightGlobeFigure(currentFigureId);
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
        highlightListFigure(figId);
        highlightTimelineFigure(figId);
        highlightMapFigure(figId);
        highlightGalleryFigure(figId);
        if (typeof highlightGlobeFigure === 'function') highlightGlobeFigure(figId);
        try { renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex); } catch (e) { }
    }
}

async function loadAndDisplayFigures($rdf) {
    const filteredFiguresIndex = filterFiguresByDateRange(minYear, maxYear);
    console.log("Filtered figures count:", filteredFiguresIndex.length);

    if (filteredFiguresIndex.length === 0) {
        console.warn("No figures found in the specified date range.");
        return;
    }

    const sortedFiguresIndex = sortFigures(filteredFiguresIndex, 'date');
    console.log("Sorted figures count:", sortedFiguresIndex.length);

    currentSortedIndex = sortedFiguresIndex;

    renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
    await renderFiguresAsList(currentSortedIndex);
    await renderFiguresAsTimeline(currentSortedIndex);

    setTimeout(() => {
        if (leafletMap) {
            leafletMap.invalidateSize();
        }
        renderFiguresOnMap(currentSortedIndex);
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
    renderKeywordSearch();

    // Default display logic: respect URL hash if present, otherwise default to first item
    let initialFigureId = sortedFiguresIndex.length > 0 ? sortedFiguresIndex[0] : null;
    const hash = window.location.hash;
    if (hash && hash.length > 1) {
        const figureId = hash.substring(1);
        if (figuresDict[figureId]) {
            initialFigureId = figureId;
        }
    }

    if (initialFigureId) {
        showFigureDetails(initialFigureId);
    }
}

// Initialization sequence
//const $rdf = require('rdflib'); // Ensure rdflib is available
// Initialize the RDF store
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
        figureListDiv.textContent = `Error loading or processing data: ${error.message}`;
        return false;
    }
}

(async function initializeAndLoadFigures() {
    if (await initializeStore($rdf)) {
        figuresDict = await buildFiguresInfoDict($rdf);
        await loadAndDisplayFigures($rdf);
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
        // current tab has no spatial filter (list/timeline).
        let visibleFigures = null;
        if (currentTab === 'figure-globe' && typeof getVisibleGlobeFigureKeys === 'function') {
            visibleFigures = getVisibleGlobeFigureKeys(); // already sorted by date
        } else if (currentTab === 'figure-map') {
            visibleFigures = sortFigures(
                getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers) || [],
                'date'
            );
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
                // On other tabs (list, timeline), use all keyword figures
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

        showFigureDetails(targetFigureId);
        highlightTimelineFigure(targetFigureId);
        scrollToTimelineFigure(targetFigureId);
        highlightListFigure(targetFigureId);
        scrollToListFigure(targetFigureId);
        highlightMapFigure(targetFigureId);
        highlightGalleryFigure(targetFigureId);

        Object.values(leafletMarkers).forEach(m => {
            clearTimeout(m._hoverCloseTimer);
            m._hoverCloseTimer = null;
            try { m.closeTooltip(); } catch {}
        });
        if (leafletMarkers[targetFigureId]) {
            openAdaptivePopup(leafletMarkers[targetFigureId], markerLabelContent(targetFigureId));
        }
    }

});

// Tab functionality for the UI
// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
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
            stopPlayback();
            openListModal();
        });
    }

    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const playBtn = document.getElementById('play-btn');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            // The "List" button is currently in the tab strip but opens a modal
            // over the active view rather than swapping tabs. Underlying view
            // (Map / Globe) is preserved.
            if (tabName === 'figure-list') {
                openListModal();
                return;
            }
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

            if (tabName === 'figure-list' && currentFigureId) {
                scrollToListFigure(currentFigureId);
                highlightListFigure(currentFigureId);
            } else if (tabName === 'figure-timeline' && currentFigureId) {
                scrollToTimelineFigure(currentFigureId);
                highlightTimelineFigure(currentFigureId);
            } else if (tabName === 'figure-map') {
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
                if (typeof initGlobe === 'function') initGlobe();
                renderGallery();
                if (currentFigureId) {
                    if (typeof highlightGlobeFigure === 'function') highlightGlobeFigure(currentFigureId);
                    // Only rotate if the current figure isn't already in view.
                    if (typeof panGlobeTo === 'function' &&
                        typeof getVisibleGlobeFigureKeys === 'function') {
                        const onScreen = getVisibleGlobeFigureKeys().includes(currentFigureId);
                        if (!onScreen) panGlobeTo(currentFigureId);
                    }
                    highlightGalleryFigure(currentFigureId);
                }
            }
        });
    });

    playBtn.addEventListener('click', () => {
        if (playBtn.dataset.playing === "true") {
            stopPlayback();
        } else {
            startPlayback();
        }
    });

    if (playParam !== null) {
        setTimeout(startPlayback, 500);
    }

    // --- Threshold slider control (allow user to slide the log threshold) ---
    try {
        // Threshold control: hidden by default. Toggle visibility with Ctrl/Cmd+Shift+L.
        const thresholdControl = document.createElement('div');
        thresholdControl.id = 'threshold-control';
        // Default hidden so it doesn't cover tab content; positioned absolutely in the header when shown.
        thresholdControl.style.display = 'none';
        thresholdControl.style.position = 'absolute';
        thresholdControl.style.top = '8px';
        thresholdControl.style.right = '8px';
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
        thresholdSlider.value = String(LOG_SCALE_THRESHOLD);
        thresholdSlider.title = 'Slide to change log threshold (years)';
        thresholdSlider.style.verticalAlign = 'middle';
        thresholdControl.appendChild(thresholdSlider);

        const thresholdValue = document.createElement('span');
        thresholdValue.style.marginLeft = '0.5em';
        thresholdValue.style.fontSize = '0.9em';
        thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
        thresholdControl.appendChild(thresholdValue);

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

        // Toggle function and keyboard shortcut (Ctrl+Shift+L)
        function toggleThresholdControlVisibility() {
            const el = document.getElementById('threshold-control');
            if (!el) return;
            const hidden = el.style.display === 'none' || el.getAttribute('aria-hidden') === 'true';
            if (hidden) {
                el.style.display = 'inline-block';
                el.setAttribute('aria-hidden', 'false');
            } else {
                el.style.display = 'none';
                el.setAttribute('aria-hidden', 'true');
            }
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

        // (duplicate old listener removed)

        // Live update while sliding; debounce final action (rerender timeline/map) when user stops
        thresholdSlider.addEventListener('input', (e) => {
            const val = Number(e.target.value);
            if (Number.isFinite(val)) {
                LOG_SCALE_THRESHOLD = val;
                thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
                // update the timescale immediately
                renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
                // If the map tab is visible, apply lightweight in-place recolor so we don't overwrite highlight styles
                if (currentTab === 'figure-map') {
                    // updateMarkerColors updates only backgroundColor on existing markers
                    try { updateMarkerColors(currentSortedIndex); } catch (e) { /* ignore */ }
                }
            }
            if (thresholdDebounceTimer) clearTimeout(thresholdDebounceTimer);
            thresholdDebounceTimer = setTimeout(() => {
                // When sliding stops, rerender the timeline if visible
                if (currentTab === 'figure-timeline') {
                    renderFiguresAsTimeline(currentSortedIndex);
                }
                // Also update the map markers if map is visible
                if (currentTab === 'figure-map') {
                    renderFiguresOnMap(currentSortedIndex);
                }
                thresholdDebounceTimer = null;
            }, 300);
        });

        // On change ensure final state is rendered
        thresholdSlider.addEventListener('change', (e) => {
            const val = Number(e.target.value);
            if (Number.isFinite(val)) {
                LOG_SCALE_THRESHOLD = val;
                thresholdValue.textContent = formatDateForDisplay(LOG_SCALE_THRESHOLD);
            }
            if (thresholdDebounceTimer) { clearTimeout(thresholdDebounceTimer); thresholdDebounceTimer = null; }
            if (currentTab === 'figure-timeline') renderFiguresAsTimeline(currentSortedIndex);
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

/**
 * Makes an element draggable using a handle (defaults to element itself or child with ID + 'label')
 */
function scrollToListFigure(figureId) {
    const currentDiv = document.getElementById(`list-${figureId}`);
    if (currentDiv) {
        currentDiv.scrollIntoView({ behavior: 'auto', block: 'center' });
    } else {
        console.warn(`Element with ID list-${figureId} not found.`);
    }
}

function highlightListFigure(figureId) {
    document.querySelectorAll('.figure-item.highlighted').forEach(div => {
        div.classList.remove('highlighted');
    });
    const currentDiv = document.getElementById(`list-${figureId}`);
    if (currentDiv) {
        currentDiv.classList.add('highlighted');
    }
}

function scrollToTimelineFigure(figureId) {
    const currentDiv = document.getElementById(`timeline-${figureId}`);
    if (currentDiv) {
        currentDiv.scrollIntoView({ behavior: 'auto', block: 'center' });
    } else {
        console.warn(`Element with ID timeline-${figureId} not found.`);
    }
}

function highlightTimelineFigure(figureId) {
    document.querySelectorAll('.timeline-figure.highlighted').forEach(div => {
        div.classList.remove('highlighted');
    });
    const currentDiv = document.getElementById(`timeline-${figureId}`);
    if (currentDiv) {
        currentDiv.classList.add('highlighted');
    }
}
// Returns figureIds for all currently open detail windows.
function getOpenWindowFigureIds() {
    return Array.from(document.querySelectorAll('.detail-window[data-figure-id]'))
        .map(w => w.dataset.figureId)
        .filter(Boolean);
}

function highlightMapFigure(figureId) {
    if (!leafletMarkers) return;

    // Collect secondary IDs: open windows that are not the primary figure.
    const secondaryIds = new Set(getOpenWindowFigureIds().filter(id => id !== figureId));

    // Reset all markers to default style.
    Object.values(leafletMarkers).forEach(m => {
        if (!m) return;
        m.setZIndexOffset(1);
        const el = m.getElement && m.getElement();
        if (el) {
            const inner = el.querySelector && el.querySelector('div');
            if (inner) {
                inner.style.border = '1.5px solid #222';
                inner.style.borderRadius = '50%';
                inner.style.transform = 'scale(1)';
                inner.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';
            }
        }
    });

    // Blue ring for secondary markers (open windows that are not primary).
    secondaryIds.forEach(id => {
        const m = leafletMarkers[id];
        if (!m) return;
        const el = m.getElement && m.getElement();
        if (el) {
            const inner = el.querySelector && el.querySelector('div');
            if (inner) {
                inner.style.border = '1.5px solid #222';
                inner.style.borderRadius = '50%';
                inner.style.transform = 'scale(1.22)';
                inner.style.boxShadow = '0 0 0 3px #1976d2, 0 1px 4px rgba(0,0,0,0.2)';
            }
        }
        m.setZIndexOffset(1000);
    });

    // Purple ring for the primary (active) marker.
    if (figureId && leafletMarkers[figureId]) {
        const marker = leafletMarkers[figureId];
        const thisEl = marker.getElement ? marker.getElement() : null;
        if (thisEl && thisEl.querySelector) {
            const innerDiv = thisEl.querySelector('div');
            if (innerDiv) {
                innerDiv.style.borderRadius = '50%';
                innerDiv.style.border = '1.5px solid #222';
                innerDiv.style.transform = 'scale(1.28)';
                innerDiv.style.boxShadow = '0 0 0 5px #CC79A7, 0 1px 4px rgba(0,0,0,0.2)';
            }
        }
        marker.setZIndexOffset(2000);
        if (isShiftKeyDown && leafletMap) {
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

function highlightKeywordMarkers(ids) {
    // Normalize ids: dedupe, remove empties/nulls
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
    const secondaryIds = new Set(getOpenWindowFigureIds().filter(id => id !== currentFigureId));
    const protectedIds = new Set([currentFigureId, ...secondaryIds].filter(Boolean));

    // Clear existing keyword highlights safely
    Object.keys(leafletMarkers).forEach((figureId) => {
        try {
            const m = leafletMarkers[figureId];
            if (!m) return;
            const el = m.getElement && m.getElement();
            if (el) {
                const inner = el.querySelector && el.querySelector('div');
                if (inner && !protectedIds.has(figureId)) inner.style.boxShadow = '';
            }
            if (secondaryIds.has(figureId)) {
                m.setZIndexOffset(1000);
            } else if (figureId !== currentFigureId) {
                m.setZIndexOffset(1);
            }
        } catch (e) {
            // ignore and continue
        }
    });

    // Apply new keyword highlights
    uniqueIds.forEach((figureId) => {
        try {
            const m = leafletMarkers[figureId];
            if (!m) return;
            if (protectedIds.has(figureId)) return;
            const el = m.getElement && m.getElement();
            if (el) {
                const inner = el.querySelector && el.querySelector('div');
                if (inner) inner.style.boxShadow = '0px 0px 6px 6px rgba(230, 159, 0, 1)';
            }
            if (figureId !== currentFigureId) {
                m.setZIndexOffset(900);
            }
        } catch (e) {
            // ignore and continue
        }
    });
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

function startPlayback() {
    const playBtn = document.getElementById('play-btn');
    playBtn.textContent = '⏸️';
    playBtn.dataset.playing = "true";

    let figures = currentSortedIndex;

    // Start from the current figure if available
    let startIndex = 0;
    if (currentFigureId) {
        const idx = figures.indexOf(currentFigureId);
        if (idx !== -1) startIndex = idx;
    }

    // override if map
    if (currentTab == "figure-map") {
        startIndex = 0;
        const visibleMarkers = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers);
        figures = sortFigures(visibleMarkers, 'date');
    }

    playIndex = startIndex;

    showFigureDetails(figures[playIndex]);
    highlightTimelineFigure(figures[playIndex]);
    scrollToTimelineFigure(figures[playIndex]);

    highlightListFigure(figures[playIndex]);
    scrollToListFigure(figures[playIndex]);

    openAdaptivePopup(leafletMarkers[figures[playIndex]], markerLabelContent(figures[playIndex]));

    playInterval = setInterval(() => {
        playIndex++;
        if (playIndex >= figures.length) {
            stopPlayback();
            return;
        }
        showFigureDetails(figures[playIndex]);
        highlightTimelineFigure(figures[playIndex]);
        scrollToTimelineFigure(figures[playIndex]);

        highlightListFigure(figures[playIndex]);
        scrollToListFigure(figures[playIndex]);

        console.log(figures[playIndex]);
        openAdaptivePopup(leafletMarkers[figures[playIndex]], markerLabelContent(figures[playIndex]));

    }, 2000);
}

function stopPlayback() {
    const playBtn = document.getElementById('play-btn');
    playBtn.textContent = '▶️';
    playBtn.dataset.playing = "false";
    if (playInterval) {
        clearInterval(playInterval);
        playInterval = null;
    }
    // Remove highlight when stopped
    document.querySelectorAll('.timeline-figure.highlighted').forEach(div => {
        div.classList.remove('highlighted');
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

function makeFiguresKWDocsArray() {
    // Map token -> Set of figure IDs (avoid duplicates)
    const documents_dict = {};

    const asText = (v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object' && v && typeof v.value === 'string') return v.value;
        return String(v);
    };

    Object.values(figuresDict).forEach((figure) => {
        let tokens = tokenizer(figure.label);
        tokens.forEach((token) => {
            if (!documents_dict[token]) documents_dict[token] = new Set();
            documents_dict[token].add(figure.id);
        });

        if (figure.cultureLabel) {
            tokens = tokenizer(asText(figure.cultureLabel));
            tokens.forEach((token) => {
                if (!documents_dict[token]) documents_dict[token] = new Set();
                documents_dict[token].add(figure.id);
            });
        }

        if (figure.materialNote) {
            tokens = tokenizer(asText(figure.materialNote));
            tokens.forEach((token) => {
                if (!documents_dict[token]) documents_dict[token] = new Set();
                documents_dict[token].add(figure.id);
            });
        }

        if (figure.note) {
            tokens = tokenizer(asText(figure.note));
            tokens.forEach((token) => {
                if (!documents_dict[token]) documents_dict[token] = new Set();
                documents_dict[token].add(figure.id);
            });
        }

        if (figure.inModernCountry) {
            tokens = tokenizer(asText(figure.inModernCountry));
            tokens.forEach((token) => {
                if (!documents_dict[token]) documents_dict[token] = new Set();
                documents_dict[token].add(figure.id);
            });
        }
    });

    // Convert Sets to arrays for MiniSearch storage and for dictionary lookups
    const documents_array = [];
    const dict_out = {};
    Object.keys(documents_dict).forEach((doc) => {
        const idsArray = Array.from(documents_dict[doc]);
        documents_array.push({ id: doc, ids: idsArray });
        dict_out[doc] = idsArray;
    });
    return { array: documents_array, dictionary: dict_out };
}



// ** Render Keyword Serch **
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
                try { highlightKeywordMarkers([]); } catch { }
                try { highlightKeywordGalleryImages([]); } catch { }
                if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights([]);
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
            try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch { }
            try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
            if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights(currentKeywordHighlightIds || []);

            if (query.length === 0) {
                setSuggestionsVisible(false);
                return;
            }

            const results = miniSearch.search(query, { prefix: true, limit: 5 });

            if (!results || results.length === 0) {
                setSuggestionsVisible(false);
                return;
            }

            function extractKw(item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (item.id) return item.id;
                if (item.suggestion) return item.suggestion;
                if (item.doc && item.doc.id) return item.doc.id;
                if (item.document && item.document.id) return item.document.id;
                if (item.id) return String(item.id);
                try { return JSON.stringify(item); } catch { return String(item); }
            }

            results.forEach(result => {
                const kwText = extractKw(result);
                if (!kwText) return;
                const li = document.createElement('li');
                li.textContent = kwText;
                li.tabIndex = 0;
                const ids = Array.isArray(figuresKWDict[kwText])
                    ? figuresKWDict[kwText]
                    : String(figuresKWDict[kwText] || '').split(' ').filter(Boolean);
                // Hover preview: temporarily highlight matching markers
                li.addEventListener('mouseover', () => {
                    try { highlightKeywordMarkers(ids); } catch { }
                    try { highlightKeywordGalleryImages(ids); } catch { }
                    if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights(ids);
                });
                li.addEventListener('mouseout', () => {
                    try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch { }
                    try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
                    if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights(currentKeywordHighlightIds || []);
                });
                li.addEventListener('click', () => {
                    searchInput.value = kwText;
                    suggestionsList.innerHTML = '';
                    setSuggestionsVisible(false);
                    currentKeywordHighlightIds = ids;
                    highlightKeywordMarkers(ids);
                    highlightKeywordGalleryImages(ids);
                    if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights(ids);
                    updateZoomKeywordButtonVisibility();
                });
                li.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') {
                        li.click();
                    }
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
            try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch { }
            try { highlightKeywordGalleryImages(currentKeywordHighlightIds || []); } catch { }
            if (typeof applyGlobeKeywordHighlights === 'function') applyGlobeKeywordHighlights(currentKeywordHighlightIds || []);
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
                if (typeof panGlobeTo === 'function' && currentKeywordHighlightIds && currentKeywordHighlightIds.length)
                    panGlobeTo(currentKeywordHighlightIds[0]);
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

function renderGallery() {

    // Both tabs show only currently-visible markers.
    //  - Map: markers within the Leaflet viewport bounds.
    //  - Globe: markers within the camera-facing spherical cap (see
    //    getVisibleGlobeFigureKeys in gaerhf-globe.js).
    let figureIds;
    if (currentTab === 'figure-globe') {
        figureIds = (typeof getVisibleGlobeFigureKeys === 'function')
            ? getVisibleGlobeFigureKeys()
            : (currentSortedIndex || []);
    } else {
        figureIds = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers);
    }

    galleryDiv = document.getElementById('gallery');
    galleryDiv.innerHTML = "";
    figureIds.forEach(function (figureId, index) {
        galleryImg = document.createElement('img');
        galleryImg.id = `gi-${figureId}`;
        galleryImg.src = thumbnailUrl(figureId);
        galleryImg.className = "gallery-image";

        maxHeight = '70'
        if (figureIds.length > 25) {
            maxHeight *= (25 / figureIds.length);
            if (maxHeight < 30) { maxHeight = 30 }
        }
        galleryImg.style = `max-height:${maxHeight}px`;

        galleryImg.addEventListener('mouseover', () => {
            if (leafletMarkers[figureId]) {
                const content = buildPopupContent(figuresDict[figureId].label, { showHint: true });
                openAdaptivePopup(leafletMarkers[figureId], content);
            }
            try { showTimescaleHoverOverlay(figureId); } catch (e) { /* ignore */ }
        });

        galleryImg.addEventListener('mouseout', () => {
            try { clearTimescaleHoverOverlay(); } catch (e) { /* ignore */ }
            if (leafletMarkers[figureId]) {
                leafletMarkers[figureId]._hoverCloseTimer = setTimeout(() => {
                    try { leafletMarkers[figureId].closeTooltip(); } catch { }
                    leafletMarkers[figureId]._hoverCloseTimer = null;
                }, 250);
            }
        });

        galleryImg.addEventListener('click', () => {
            stopPlayback();
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
    if (currentTab === 'figure-globe' && typeof getVisibleGlobeFigureKeys === 'function') {
        ids = getVisibleGlobeFigureKeys();
    } else if (leafletMap) {
        ids = sortFigures(getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers), 'date');
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

    // Create gradient bar. If the LOG_SCALE_THRESHOLD lies inside the range,
    // show a subtle mid-stop so users can see the visual split.
    const bar = document.createElement('div');
    bar.style.width = '100%';
    bar.style.height = '16px';
    bar.style.position = 'absolute';
    bar.style.bottom = '4px'; // 4px from bottom of container
    bar.style.left = '0';
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

    if (threshPos > 0 && threshPos < 1) {
        // Use a three-stop gradient with threshold highlighted by a mid tone
        const p = Math.round(threshPos * 100);
        const grad = `linear-gradient(to right, black 0%, #666 ${p}%, white 100%)`;
        // Set both background and backgroundImage to maximize cross-browser support
        bar.style.backgroundImage = grad;
        bar.style.background = grad;
    } else {
        const grad = `linear-gradient(to right, black, white)`;
        bar.style.backgroundImage = grad;
        bar.style.background = grad;
    }
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
            label.style.left = `${percent}%`;
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

function updateMarkerColors(figuresArray) {
    const [minDate, maxDate] = getTimescaleRange(figuresArray);
    if (minDate === maxDate) return;

    Object.keys(leafletMarkers).forEach(figureId => {
        const marker = leafletMarkers[figureId];
        if (!marker) return;
        const el = marker.getElement && marker.getElement();
        if (!el) return;
        const inner = el.querySelector && el.querySelector('div');
        if (!inner) return;

        const figure = figuresDict[figureId];
        const date = figure ? getFigureStart(figure) : null;
        let color = 'rgb(128,128,128)'; // fallback neutral
        if (date !== null && !isNaN(date)) {
            const scale = timelineScale(date, minDate, maxDate);
            const gray = Math.round(Math.max(0, Math.min(1, scale)) * 255);
            color = `rgb(${gray},${gray},${gray})`;
        }

        // IMPORTANT: only set the background color property to avoid overwriting border/boxShadow
        inner.style.backgroundColor = color;
        // Do NOT touch inner.style.border, inner.style.boxShadow, inner.style.borderRadius, or inner.style.cssText
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
