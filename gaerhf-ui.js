const turtleUrl = 'gaerhf.ttl';
const figureListDiv = document.getElementById('figure-list');
const figureDetailsDiv = document.getElementById('figure-details');
const detailLabel = document.getElementById('detail-label');
const detailInfo = document.getElementById('detail-info');
const detailImageDiv = document.getElementById('detail-image');
const headerContainer = document.getElementById('header-container');

const minYear = -50000; // Minimum year
const maxYear = 1300;     // Maximum year

// Check for 'play' CGI parameter in the URL
const urlParams = new URLSearchParams(window.location.search);
const playParam = urlParams.get('play');
const viewParam = urlParams.get('view')

// Initialize the figures dictionary
let figuresDict = {};
let currentSortedIndex = [];
let tp;

// Playback variables
let playInterval = null;
let playIndex = 0;

let currentFigureId = null;
let currentTab = "figure-map";

let leafletMap = null;
let leafletMarkers = {}; // Place this at the top level

let visibleMarkers = null ;
let thresholdDebounceTimer = null;
let isOptionKeyDown = false;
let currentKeywordHighlightIds = [];

// Helper: open callout with adaptive behavior
// Note: Leaflet's 'direction' option is for Tooltips (not Popups).
// We use a tooltip styled like a popup when near the top, otherwise a normal popup.
function openAdaptivePopup(marker, content) {
    if (!leafletMap || !marker) return;
    try {
        const pt = leafletMap.latLngToContainerPoint(marker.getLatLng());
        const topThreshold = 300; // px from top to trigger below placement

        // Always ensure popup is bound for the normal case
        marker.unbindPopup();
        marker.bindPopup(content, { offset: [0, -6], autoPan: false });

        if (pt.y < topThreshold) {
            // Near top: use a tooltip that appears below the marker
            // Close any popup that might be open
            try { marker.closePopup(); } catch {}
            // Rebind tooltip with bottom direction
            marker.unbindTooltip();
            marker.bindTooltip(content, {
                direction: 'bottom',
                offset: [0, 10],
                opacity: 1,
                permanent: false,
                sticky: false,
                interactive: true,
                className: 'popup-like'
            });
            marker.openTooltip();
        } else {
            // Normal case: open actual popup above marker
            marker.unbindTooltip();
            marker.openPopup();
        }
    } catch (err) {
        // Fallback to standard behavior
        try {
            marker.unbindTooltip();
            marker.unbindPopup();
            marker.bindPopup(content, { autoPan: false });
            marker.openPopup();
        } catch (e) { /* ignore */ }
    }
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

function formatDateForDisplay(date) {
    if (date === null) {
        return '';
    }
    const year = Math.abs(date);
    const era = date < 0 ? ' BCE' : ' CE';
    return `${year}${era}`;
}

// Sorting and Filtering functions
function filterFiguresByDateRange(startYear, endYear) {

    return Object.keys(figuresDict).filter(figureId => {
        const figure = figuresDict[figureId];
        const figureStartDate = figure.earliestDate || figure.date || figure.approximateDate;
        const figureEndDate = figure.latestDate || figure.date || figure.approximateDate;

        return (
            (figureStartDate >= startYear && figureStartDate <= endYear) || // Start date is within range
            (figureEndDate >= startYear && figureEndDate <= endYear) ||     // End date is within range
            (figureStartDate <= startYear && figureEndDate >= endYear)      // Range overlaps the selected range
        );
    });
}

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
        [figureType, groupType].forEach(async type => {
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
                const wikipediaImagePage = tp.anyValue(subject, wikipediaImagePageProp) || null;
                const describedBy = tp.each(subject, describedByProp).map(val => val.value);
                const thumbnailURL = tp.anyValue(subject, thumbnailImageProp) || null;
                
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
                    wikipediaImagePage: wikipediaImagePage,  // string or null
                    thumbnailURL: thumbnailURL,  // string or null
                    representativeLatLongPoint: representativeLatLongPoint,  // [number, number] or null
                };
            }));
        });
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

        const figureStartDate = figure.earliestDate || figure.date || figure.approximateDate;
        const figureEndDate = figure.latestDate || figure.date || figure.approximateDate;

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

        // let thumbnailUrl = null;
        // if (figure.thumbnailURL) {
        //     thumbnailUrl = figure.thumbnailURL;
        // } else if (figure.wikipediaImagePage) {
        //     thumbnailUrl = await getWikimediaImageUrl(figure.wikipediaImagePage, 50); // Await the async call
        // }

        // if (thumbnailUrl) {
        const thumbnailImg = document.createElement('img');
        thumbnailImg.src = "/thumbnails/" + figureId + ".png" ;
        thumbnailImg.loading = "lazy" ;
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
            highlightListFigure(figure.id) ;
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

    // Get valid dates for the timeline
    const validDates = figuresDisplayIndex
        .map(id => figuresDict[id])
        .filter(figure => figure.earliestDate || figure.date || figure.approximateDate);

    if (validDates.length === 0) {
        timelineContainer.textContent = 'No valid dates found for the selected range.';
        return;
    }

    // Calculate the earliest and latest dates
    const earliestDate = Math.min(
        ...validDates.map(figure => figure.earliestDate || figure.date || figure.approximateDate)
    );
    const latestDate = Math.max(
        ...validDates.map(figure => figure.latestDate || figure.date || figure.approximateDate)
    );

    if (isNaN(earliestDate) || isNaN(latestDate) || earliestDate === latestDate) {
        timelineContainer.textContent = 'No valid dates found for the selected range.';
        return;
    }

    // Get the width of the timeline container for label positioning
    const containerWidth = timelineContainer.offsetWidth;

    let hoverTimeout = null;

    figuresDisplayIndex.forEach((figureId, index) => {
        const figure = figuresDict[figureId];
        const startDate = figure.earliestDate || figure.date || figure.approximateDate;
        const endDate = figure.latestDate || figure.date || figure.approximateDate;

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

function renderFiguresOnMap(figuresArray) {
    // Only initialize once
    if (!leafletMap) {
        leafletMap = L.map('figure-map', { 
            worldCopyJump: true,
            keyboard: false  // CRITICAL: Disable Leaflet's keyboard handler completely
        }).setView([20, 0], 1.8); // World view
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(leafletMap);
        // Disable automatic map panning for ALL popups globally (simplifies hover behavior)
        try { L.Popup.prototype.options.autoPan = false; } catch (e) { /* ignore if Leaflet not loaded */ }
        // Explicitly raise popup pane z-index in JS in case CSS loads late or is overridden
        try { leafletMap.getPanes().popupPane.style.zIndex = '20000'; } catch (e) { /* ignore */ }
        leafletMap.on('zoomend', function() {
            renderGallery() ;
            highlightGalleryFigure(currentFigureId)
            });
        leafletMap.on('moveend', function () {
            renderGallery() ;
            highlightGalleryFigure(currentFigureId)
            });
    }

    // We'll update markers in-place where possible to preserve highlight styles
    // Do NOT recreate all markers — update existing markers' background color, create missing ones,
    // and remove markers that are no longer needed. This avoids losing border/boxShadow highlights.

    // Find min/max date for scaling
    const validFigures = figuresArray
        .map(id => figuresDict[id])
        .filter(f => f && (f.earliestDate !== null || f.date !== null || f.approximateDate !== null));
    const minDate = Math.min(...validFigures.map(f => f.earliestDate ?? f.date ?? f.approximateDate));
    const maxDate = Math.max(...validFigures.map(f => f.latestDate ?? f.date ?? f.approximateDate));

    // Update existing markers in-place where possible (to preserve highlight borders/shadows),
    // create markers for figures that don't yet have one, and remove any leftover markers
    // that are not in the current figuresArray.
    const toKeep = new Set();

    figuresArray.forEach(figureId => {
        const figure = figuresDict[figureId];
        if (!figure || !figure.representativeLatLongPoint) return;

        const [lat, lng] = figure.representativeLatLongPoint;
        const date = figure.earliestDate ?? figure.date ?? figure.approximateDate;
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
                const icon = L.divIcon({
                    className: 'custom-gray-marker',
                    iconSize: [10, 10],
                    iconAnchor: [6, 6],
                    popupAnchor: [0, -6],
                    html: `<div style="width:10px;height:10px;background:${color};border-radius:50%;border:1.5px solid #222;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>`
                });
                existingMarker.setIcon(icon);
            }
            toKeep.add(figureId);
            return;
        }

        // Otherwise create a new marker (first time seen)
        const icon = L.divIcon({
            className: 'custom-gray-marker',
            iconSize: [10, 10],
            iconAnchor: [6, 6],
            popupAnchor: [0, -6],
            html: `<div style="width:10px;height:10px;background:${color};border-radius:50%;border:1.5px solid #222;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>`
        });

        const marker = L.marker([lat, lng], { icon }).addTo(leafletMap);
        marker.bindPopup(`<strong>${figure.label || figure.id}</strong>`);
        marker.on('click', () => { 
            highlightMapFigure(figureId);
            highlightGalleryFigure(figureId) ;
            showFigureDetails(figureId);
            clickContent = `<strong>${figure.label || figure.id}</strong>`;
            openAdaptivePopup(marker, clickContent);
        });
        marker.on('mouseover', () => {
            mouseOverContent = `<strong>${figure.label || figure.id}</strong><div><img style="max-width:75px;max-height:150px" src="/thumbnails/${figure.id}.png" loading="lazy"></div>`;
            openAdaptivePopup(marker, mouseOverContent);
            try { showTimescaleHoverOverlay(figureId); } catch (e) { /* ignore */ }
        });

        marker.on('mouseout', () => {
            // Hide hover overlay immediately and close popup after a short delay
            try { clearTimescaleHoverOverlay(); } catch (e) { /* ignore */ }
            marker._hoverCloseTimer = setTimeout(() => {
                try { marker.closePopup(); } catch {}
                try { marker.closeTooltip && marker.closeTooltip(); } catch {}
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
            highlightMapFigure(currentFigureId) ;
            highlightGalleryFigure(currentFigureId)
        }
    } catch (err) {
        // ignore
    }

}

async function showFigureDetails(figureId) {
    currentFigureId = figureId;

    // Update the URL hash without reloading the page
    if (window.location.hash !== `#${figureId}`) {
        history.replaceState(null, '', `#${figureId}`);
    }

    const figure = figuresDict[figureId];
    if (figure && headerContainer) {
        detailLabel.textContent = figure.label || figure.id;

        // Add direct link icon
        const linkIcon = document.createElement('a');
        linkIcon.href = `/#${figure.id}`;
        linkIcon.target = '_blank';
        linkIcon.style.marginLeft = '0.6em';
        linkIcon.style.fontSize = '.5em';
        linkIcon.title = 'Direct link to this figure';
        // Unicode "link" icon: 🔗 (U+1F517)
        linkIcon.textContent = '🔗';
        detailLabel.appendChild(linkIcon);

        detailInfo.innerHTML = '';
        detailImageDiv.innerHTML = '';

        let detailImageUrl = null;
        if (figure.thumbnailURL) {
            detailImageUrl = figure.thumbnailURL;
        } else if (figure.wikipediaImagePage) {
            detailImageUrl = await getWikimediaImageUrl(figure.wikipediaImagePage, 200); // Await the async call
        }

    
        const detailImg = document.createElement('img');
        detailImg.src = "/thumbnails/" + figure.id + ".png" ;
        detailImg.classList.add('detail-image-style');

        // Swap to large image on hover
        detailImg.addEventListener('mouseover', () => {
            detailImg.src = "/large/" + figure.id + ".png";
            detailImg.style.maxWidth = 500 ;
        });
        detailImg.addEventListener('mouseout', () => {
            detailImg.src = "/thumbnails/" + figure.id + ".png";
            detailImg.style.maxWidth = 200 ;
        });

        detailA = document.createElement('a');
        detailA.href = `https://lens.google.com/uploadbyurl?url=${detailImageUrl}` ;
        detailA.appendChild(detailImg)
        detailA.setAttribute('title', "Click for Google Image Search")

        detailImageDiv.appendChild(detailA);


        if (figure.cultureLabel && figure.cultureDescribedBy) {
            const cultureLink = document.createElement('p');
            const strongElement = document.createElement('strong');
            strongElement.textContent = 'Art Historical Tradition or Culture: ';
            const link = document.createElement('a');
            link.href = figure.cultureDescribedBy;
            link.textContent = figure.cultureLabel;

            cultureLink.appendChild(strongElement);
            cultureLink.appendChild(link);
            detailInfo.appendChild(cultureLink);
        } else if (figure.cultureLabel) {
            detailInfo.innerHTML += `<p><strong>Art Historical Tradition or Culture:</strong> ${figure.cultureLabel}</p>`;
        } else if (figure.culture) {
            detailInfo.innerHTML += `<p><strong>Art Historical Tradition or Culture:</strong> ${figure.culture}</p>`;
        }

        if (figure.inModernCountry) {
            detailInfo.innerHTML += `<p><strong>Modern Country:</strong> ${figure.inModernCountry}</p>`;
        }

        if (figure.materialNote) {
            detailInfo.innerHTML += `<p><strong>Material:</strong> ${figure.materialNote}</p>`;
        }

        if (figure.date !== null) {
            detailInfo.innerHTML += `<p><strong>Date:</strong> ${formatDateForDisplay(figure.date)}</p>`;
        }
        if (figure.approximateDate !== null) {
            detailInfo.innerHTML += `<p><strong>Approximate Date:</strong> ${formatDateForDisplay(figure.approximateDate)}</p>`;
        }

        if (figure.latestDate !== null) {
            append_to_date = ` to ${formatDateForDisplay(figure.latestDate)}`
        }

        if (figure.earliestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Date Range:</strong> ${formatDateForDisplay(figure.earliestDate)}${append_to_date}</p>`;
        }

        if (figure.describedBy && figure.describedBy.length > 0) {
            const morePara = document.createElement('p');
            morePara.textContent = 'More: ';
            figure.describedBy.forEach((url, idx) => {
                const link = document.createElement('a');
                link.href = url;
                try {
                    link.textContent = new URL(url).hostname;
                } catch {
                    link.textContent = url;
                }
                link.target = '_blank';
                morePara.appendChild(link);
                if (idx < figure.describedBy.length - 1) {
                    morePara.appendChild(document.createTextNode(', '));
                }
            });
            detailInfo.appendChild(morePara);
        }

        if (figure.note) {
            detailInfo.innerHTML += `<p><strong>Note:</strong> ${figure.note}</p>`;
        }

        // const directLink = document.createElement('p');
        // const link = document.createElement('a');
        // link.href = `/#${figure.id}`;
        // link.textContent = 'Direct Link';
        // link.target = '_blank';
        // directLink.appendChild(link);
        // detailInfo.appendChild(directLink);

    } else {
        console.error("Figure details not found for ID:", figureId);
    }
    // Rerender the timescale so the selected figure's span/line is shown
    try {
        renderFiguresAsTimescale(minYear, maxYear, currentSortedIndex);
    } catch (err) {
        // defensive: ignore
    }
}

async function getWikimediaImageUrl(pageUrl, width = 200) {
    try {
        const parts = pageUrl.split('/');
        const filename = parts[parts.length - 1];
        const apiUrlBase = 'https://commons.wikimedia.org/w/api.php';
        const apiUrl = `${apiUrlBase}?action=query&prop=imageinfo&iiprop=url|thumburl&titles=${filename}&iiurlwidth=${width}&format=json&origin=*`;
        const response = await fetch(apiUrl);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];

        if (pageId !== "-1" && pages[pageId].imageinfo && pages[pageId].imageinfo[0].thumburl) {
            return pages[pageId].imageinfo[0].thumburl;
        } else {
            console.error("Could not retrieve thumbnail URL from the API response for:", pageUrl);
            return null;
        }
    } catch (error) {
        console.error("An error occurred while fetching Wikimedia image info:", error);
        return null;
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

    renderFiguresAsList(currentSortedIndex);
    renderFiguresAsTimeline(currentSortedIndex);
    setTimeout(() => {
                    if (leafletMap) {
                        leafletMap.invalidateSize();
                    }
                    renderFiguresOnMap(currentSortedIndex);

                    // Open popup for current figure if present
                    if (currentFigureId && leafletMarkers[currentFigureId]) {
                        leafletMap.setView(leafletMarkers[currentFigureId].getLatLng(), 3)
                        const thisEl = leafletMarkers[currentFigureId].getElement && leafletMarkers[currentFigureId].getElement();
                        if (thisEl) {
                            highlightMapFigure(currentFigureId) ;
                            highlightGalleryFigure(currentFigureId) ;
                        }
                    
                        leafletMarkers[currentFigureId].openPopup();
                    }
                }, 200);
    renderKeywordSearch();
    // --- Add this block ---
    // Check for hash in URL and show that figure is present and valid
    const hash = window.location.hash;
    if (hash && hash.length > 1) {
        const figureId = hash.substring(1);
        if (figuresDict[figureId]) {
            showFigureDetails(figureId);
            return; // Don't show the first by default if hash is present
        }
    }
    // --- End block ---

    if (sortedFiguresIndex.length > 0) {
        showFigureDetails(sortedFiguresIndex[0]);
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
    }
    loadAndDisplayFigures($rdf);
})();

// Track Option/Alt key state globally
document.addEventListener('keydown', (event) => {
  if (event.key === 'Alt') {
    isOptionKeyDown = true;
  }
});

document.addEventListener('keyup', (event) => {
  if (event.key === 'Alt') {
    isOptionKeyDown = false;
  }
});

// Reset on window blur (in case user releases key while window not focused)
window.addEventListener('blur', () => {
  isOptionKeyDown = false;
});

document.addEventListener('keydown', (event) => {

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === "Tab" ) {
    // Prevent default scrolling behavior
    event.preventDefault();
    
    // Get visible markers on the map
    const visibleFigures = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers);
    if (!visibleFigures || visibleFigures.length === 0) return;

    // Sort them by date for consistent navigation
    const sortedVisibleFigures = sortFigures(visibleFigures, 'date');

    let targetIndex = 0;

    // Check if currentFigureId is in the visible set (test via gallery element)
    const isCurrentVisible = document.getElementById(`gi-${currentFigureId}`);
    
    if (isCurrentVisible && currentFigureId) {
      // Current figure is visible, move to next/previous
      const idx = sortedVisibleFigures.indexOf(currentFigureId);
      if (idx !== -1) {
        if (event.key === 'ArrowLeft') {
          targetIndex = idx > 0 ? idx - 1 : sortedVisibleFigures.length - 1;
        } else { // ArrowRight
          targetIndex = idx < sortedVisibleFigures.length - 1 ? idx + 1 : 0;
        }
      }
    } else {
      // Current figure not visible, go to first visible figure
      targetIndex = 0;
    }

    const targetFigureId = sortedVisibleFigures[targetIndex];

    showFigureDetails(targetFigureId);
    highlightTimelineFigure(targetFigureId);
    scrollToTimelineFigure(targetFigureId);
    highlightListFigure(targetFigureId);
    scrollToListFigure(targetFigureId);
    highlightMapFigure(targetFigureId);
    highlightGalleryFigure(targetFigureId);

    if (leafletMarkers[targetFigureId]) {
      leafletMarkers[targetFigureId].openPopup();
    }
  }

});

// Tab functionality for the UI
// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const playBtn = document.getElementById('play-btn');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove 'active' from all
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            // Add 'active' to clicked button and corresponding content
            button.classList.add('active');
            const tabName = button.getAttribute('data-tab');
            currentTab = tabName ;
            const activeContent = document.getElementById(`${tabName}-container`);
            if (activeContent) {
                activeContent.classList.add('active');
            }

            // --- Scroll to current figure in the relevant view ---
            if (tabName === 'figure-list' && currentFigureId) {
                scrollToListFigure(currentFigureId);
                highlightListFigure(currentFigureId);
            } else if (tabName === 'figure-timeline' && currentFigureId) {
                scrollToTimelineFigure(currentFigureId);
                highlightTimelineFigure(currentFigureId);
            } else if (tabName === 'figure-map') {
                // For the map tab, ensure the map is rendered and centered on the current figure
                setTimeout(() => {
                    if (leafletMap) {
                        leafletMap.invalidateSize();
                    }
                    leafletMap.getPane('popupPane').style.zIndex = 3000; // Default is likely 650
                    renderFiguresOnMap(currentSortedIndex);

                    // Open popup for current figure if present
                    if (currentFigureId && leafletMarkers[currentFigureId]) {
                        leafletMarkers[currentFigureId].openPopup();
                        highlightMapFigure(currentFigureId) ;
                        highlightGalleryFigure(currentFigureId)
                    }
                }, 200); // Delay to allow the tab to become visible
            }
            // ------------------------------------------------------
        });
    });

    playBtn.addEventListener('click', () => {
        if (playBtn.dataset.playing === "true") {
            stopPlayback();
        } else {
            startPlayback();
        }
    });

    // Auto-start playback if 'play' parameter is present
    if (playParam !== null) {
        setTimeout(() => {
            startPlayback();
        }, 500);
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
});



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
        console.warn(`Element with ID list-${figureId} not found.`);
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

function highlightMapFigure(figureId) {

        Object.values(leafletMarkers).forEach(m => {
        m.setZIndexOffset(1);
        const el = m.getElement && m.getElement();
        if (el) {
            const inner = el.querySelector && el.querySelector('div');
            if (inner) {
                inner.style.border = '1.5px solid #222';
                inner.style.borderRadius = '50%';
            }
        }
    });

        // Highlight this marker (give it the requested border)
        const thisEl = leafletMarkers[figureId].getElement && leafletMarkers[figureId].getElement();
        if (thisEl) {
            const innerDiv = thisEl.querySelector && thisEl.querySelector('div');
            if (innerDiv) {
                innerDiv.style.borderRadius = '50%';
                innerDiv.style.border = '3px solid #ee0c0cff';
            }
        }

        leafletMarkers[figureId].setZIndexOffset(1000);
        
        // Center map on this marker only if Option/Alt key is held
        if (isOptionKeyDown && leafletMap && leafletMarkers[figureId]) {
            leafletMap.panTo(leafletMarkers[figureId].getLatLng());
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
        selectedImg.style.border = '3px solid #ee0c0cff';
        // Scroll to make the highlighted image visible
        selectedImg.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
}

function highlightKeywordMarkers(ids) {
    // Normalize ids: dedupe, remove empties/nulls
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));

    // Clear existing keyword highlights safely
    Object.keys(leafletMarkers).forEach((figureId) => {
        try {
            const m = leafletMarkers[figureId];
            if (!m) return;
            const el = m.getElement && m.getElement();
            if (el) {
                const inner = el.querySelector && el.querySelector('div');
                if (inner) inner.style.boxShadow = '';
            }
            if (figureId !== currentFigureId) {
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
            const el = m.getElement && m.getElement();
            if (el) {
                const inner = el.querySelector && el.querySelector('div');
                if (inner) inner.style.boxShadow = '0px 0px 5px 5px rgba(15, 235, 19, 1)';
            }
            if (figureId !== currentFigureId) {
                m.setZIndexOffset(900);
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

    figures = currentSortedIndex ;

    // Start from the current figure if available
    let startIndex = 0;
    if (currentFigureId) {
        const idx = figures.indexOf(currentFigureId);
        if (idx !== -1) startIndex = idx;
    }

    // override if map
    if (currentTab == "figure-map") {
        startIndex = 0;
        visibleMarkers = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers)
        figures = sortFigures(visibleMarkers, 'date');
    }

    playIndex = startIndex;

    showFigureDetails(figures[playIndex]);
    highlightTimelineFigure(figures[playIndex]) ;
    scrollToTimelineFigure(figures[playIndex]) ;

    highlightListFigure(figures[playIndex]) ;
    scrollToListFigure(figures[playIndex]) ;

    leafletMarkers[figures[playIndex]].openPopup();

    playInterval = setInterval(() => {
        playIndex++;
        if (playIndex >= figures.length) {
            stopPlayback();
            return;
        }
        showFigureDetails(figures[playIndex]);
        highlightTimelineFigure(figures[playIndex]) ;
        scrollToTimelineFigure(figures[playIndex]) ;

        highlightListFigure(figures[playIndex]) ;
        scrollToListFigure(figures[playIndex]) ;

        console.log(figures[playIndex]) ;
        leafletMarkers[figures[playIndex]].openPopup();

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

    kwCombined = makeFiguresKWDocsArray() ;
    figuresKWArray = kwCombined['array'] ;
    figuresKWDict = kwCombined['dictionary'] ;

    miniSearch.addAll(figuresKWArray);

    const searchInput = document.getElementById('search-input');
    const suggestionsList = document.getElementById('suggestions-list');
    let searchDebounceTimer = null; // debounce timer for typeahead

    // Start hidden
    suggestionsList.style.display = 'none';

    searchInput.addEventListener('input', () => {
        // Debounce to only search after user pauses typing
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            const query = searchInput.value.trim();
            suggestionsList.innerHTML = '';
            // Restore persistent highlight when regenerating list
            try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch {}

            if (query.length === 0) {
                suggestionsList.style.display = 'none';
                return;
            }

            const results = miniSearch.search(query, { prefix: true, limit: 5 });

            if (!results || results.length === 0) {
                suggestionsList.style.display = 'none';
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
                    try { highlightKeywordMarkers(ids); } catch {}
                });
                li.addEventListener('mouseout', () => {
                    try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch {}
                });
                li.addEventListener('click', () => {
                    searchInput.value = kwText;
                    suggestionsList.innerHTML = '';
                    suggestionsList.style.display = 'none';
                    currentKeywordHighlightIds = ids;
                    highlightKeywordMarkers(ids);
                });
                li.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') {
                        li.click();
                    }
                });
                suggestionsList.appendChild(li);
            });

            suggestionsList.style.display = 'block';
        }, 450); // ~0.5s debounce
    });

    // Hide suggestions when input loses focus (small delay keeps click working)
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            suggestionsList.style.display = 'none';
            // Restore persistent highlight when suggestions close
            try { highlightKeywordMarkers(currentKeywordHighlightIds || []); } catch {}
        }, 150);
    });

    // Optional: show suggestions when input gains focus if it already has text
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length > 0 && suggestionsList.children.length > 0) {
            suggestionsList.style.display = 'block';
        }
    });

}

function renderGallery() {

            visibleMarkers = getVisibleLeafletMarkerKeys(leafletMap, leafletMarkers) ;
            galleryDiv = document.getElementById('gallery') ;
            galleryDiv.innerHTML = "" ;
            visibleMarkers.forEach(function(figureId, index) {
                galleryImg = document.createElement('img') ;
                galleryImg.id = `gi-${figureId}` ;
                galleryImg.src = `/thumbnails/${figureId}.png` ;
                galleryImg.className = "gallery-image" ;

                maxHeight = '70'
                if (visibleMarkers.length > 25) {
                    maxHeight *= (25/visibleMarkers.length) ;
                    if (maxHeight < 30) { maxHeight = 30} 
                }
                galleryImg.style = `max-height:${maxHeight}px` ;

                galleryImg.addEventListener('mouseover', () => {
                    mouseOverContent = `<strong>${figuresDict[figureId].label}</strong> <!-- <div><img style="max-width:75px;max-height:150px" src="/thumbnails/.png" loading="lazy"></div> -->`
                    leafletMarkers[figureId].getPopup().setContent(mouseOverContent);
                    leafletMarkers[figureId].openPopup();
                    try { showTimescaleHoverOverlay(figureId); } catch (e) { /* ignore */ }
                });

                galleryImg.addEventListener('mouseout', () => {
                // small delay so quick moves don't flicker
                    try { clearTimescaleHoverOverlay(); } catch (e) { /* ignore */ }
                    leafletMarkers[figureId]._hoverCloseTimer = setTimeout(() => {
                    leafletMarkers[figureId].closePopup();
                    leafletMarkers[figureId]._hoverCloseTimer = null;
                }, 250);
                });

                galleryImg.addEventListener('click', () => {
                    highlightMapFigure(figureId) ;
                    highlightGalleryFigure(figureId) ;
                    leafletMarkers[figureId].closePopup();
                    showFigureDetails(figureId);
                });
                
                galleryDiv.appendChild(galleryImg) ;
            } ) ;


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
            // red: use hex for line, helper will compute translucent fill
            showTimescaleOverlay(bar, currentFigureId, '#ee0c0c', 'timescale-selected', minN, maxN);
        }
    } catch (err) {
        console.warn('Could not render selected-figure overlay on timescale:', err);
    }
}

function updateMarkerColors(figuresArray) {
    const ids = Array.isArray(figuresArray) && figuresArray.length > 0 ? figuresArray : currentSortedIndex || Object.keys(figuresDict);

    const validFigures = ids
        .map(id => figuresDict[id])
        .filter(f => f && (f.earliestDate != null || f.date != null || f.approximateDate != null));

    if (validFigures.length === 0) return;

    const minDate = Math.min(...validFigures.map(f => f.earliestDate ?? f.date ?? f.approximateDate));
    const maxDate = Math.max(...validFigures.map(f => f.latestDate ?? f.date ?? f.approximateDate));

    // Guard: avoid division by zero, timelineScale already guards but keep defensive
    if (!isFinite(minDate) || !isFinite(maxDate) || minDate === maxDate) return;

    Object.keys(leafletMarkers).forEach(figureId => {
        const marker = leafletMarkers[figureId];
        if (!marker) return;
        const el = marker.getElement && marker.getElement();
        if (!el) return;
        const inner = el.querySelector && el.querySelector('div');
        if (!inner) return;

        const figure = figuresDict[figureId];
        const date = figure ? (figure.earliestDate ?? figure.date ?? figure.approximateDate) : null;
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
function getTimescaleRange() {
    // Prefer the currently-sorted index range, otherwise fall back to all figures
    const ids = Array.isArray(currentSortedIndex) && currentSortedIndex.length > 0 ? currentSortedIndex : Object.keys(figuresDict || {});
    const valid = ids.map(id => figuresDict[id]).filter(f => f && (f.earliestDate != null || f.date != null || f.approximateDate != null));
    if (!valid || valid.length === 0) return [minYear, maxYear];
    const minN = Math.min(...valid.map(f => f.earliestDate ?? f.date ?? f.approximateDate));
    const maxN = Math.max(...valid.map(f => f.latestDate ?? f.date ?? f.approximateDate));
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
                const r = parseInt(h.slice(0,2), 16);
                const g = parseInt(h.slice(2,4), 16);
                const b = parseInt(h.slice(4,6), 16);
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

        let figStart = figuresDict[figureId].earliestDate ?? figuresDict[figureId].date ?? figuresDict[figureId].approximateDate;
        let figEnd = figuresDict[figureId].latestDate ?? figuresDict[figureId].date ?? figuresDict[figureId].approximateDate;
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
