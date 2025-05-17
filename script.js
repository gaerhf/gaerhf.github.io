const turtleUrl = 'gaerhf.ttl';
const figureListDiv = document.getElementById('figure-list');
const figureDetailsDiv = document.getElementById('figure-details');
const detailLabel = document.getElementById('detail-label');
const detailInfo = document.getElementById('detail-info');
const detailImageDiv = document.getElementById('detail-image');
const headerContainer = document.getElementById('header-container');

const minYear = -50000; // Minimum year
const maxYear = 1300;     // Maximum year

// Initialize the figures dictionary
let figuresDict = {};
let currentSortedIndex = [];
let tp;

// Playback variables
let timelinePlayInterval = null;
let timelinePlayIndex = 0;

let currentFigureId = null;

// Convenience functions
function formatDateForDisplay(date) {
    if (date === null) {
        return '';
    }
    const year = Math.abs(date);
    const era = date < 0 ? ' BCE' : ' CE';
    return `${year}${era}`;
}

async function getWikimediaImageUrl(pageUrl, width = 200) {
    try {
        const parts = pageUrl.split('/');
        const filename = parts[parts.length - 1];
        const apiUrlBase = 'https://commons.wikimedia.org/w/api.php';
        const apiUrl = `${apiUrlBase}?action=query&prop=imageinfo&iiprop=url|thumburl&titles=${filename}&iiurlwidth=${width}&format=json&origin=*`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId !== "-1" && pages[pageId].imageinfo && pages[pageId].imageinfo[0].thumburl) {
            return String(pages[pageId].imageinfo[0].thumburl); // Explicitly return a string
            //return "https://kaa-images.s3.us-east-2.amazonaws.com/thumbs/KA002-D03-001-Cf.png";
        } else {
            console.error("Could not retrieve thumbnail URL from the API response for:", pageUrl);
            return null;
        }
    } catch (error) {
        console.error("An error occurred while fetching Wikimedia image info:", error);
        return null;
    }
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
    const wikipediaImagePageProp = $rdf.sym('urn:gaerhf:id:wikimedia-commons-image-page');
    const thumbnailImageProp = $rdf.sym('urn:gaerhf:id:thumbnail-image'); // New property

    const processedDict = {};

    try {
        [figureType, groupType].forEach(async type => {
            const subjectsOfType = tp.each(null, rdfType, type);
            console.log("Found subjects of type:", type.uri, "Count:", subjectsOfType.length);

            await Promise.all(subjectsOfType.map(async subject => {
                const shortId = subject.uri.replace('urn:gaerhf:id:', '');

                const label = tp.anyValue(subject, rdfsLabelProp);

                const dateStr = tp.anyValue(subject, dateProp);
                const earliestDateStr = tp.anyValue(subject, earliestDateProp);
                const latestDateStr = tp.anyValue(subject, latestDateProp);
                const approximateDateStr = tp.anyValue(subject, approximateDateProp);

                // Convert date strings to numbers
                const date = dateStr ? parseFloat(dateStr) : null;
                const earliestDate = earliestDateStr ? parseFloat(earliestDateStr) : null;
                const latestDate = latestDateStr ? parseFloat(latestDateStr) : null;
                const approximateDate = approximateDateStr ? parseFloat(approximateDateStr) : null;

                const note = tp.anyValue(subject, noteProp);

                const culture = tp.any(subject, cultureProp);
                let cultureShortId = null;
                let cultureLabel = null;
                let cultureDescribedBy = null;

                const inModernCountry = tp.any(subject, inModernCountryProp);
                const wikipediaImagePage = tp.anyValue(subject, wikipediaImagePageProp);
                const describedBy = tp.anyValue(subject, describedByProp);
                const thumbnailURL = tp.anyValue(subject, thumbnailImageProp); // Get explicit thumbnail

                if (culture) {
                    cultureShortId = culture.uri.replace('urn:gaerhf:id:', '');
                    cultureLabel = tp.anyValue(culture, rdfsLabelProp);
                    cultureDescribedBy = tp.anyValue(culture, describedByProp);
                }

                processedDict[shortId] = {
                    id: shortId,
                    label: label || shortId,
                    date: date,
                    earliestDate: earliestDate,
                    latestDate: latestDate,
                    approximateDate: approximateDate,
                    describedBy: describedBy,
                    note: note,
                    culture: cultureShortId,
                    cultureLabel: cultureLabel,
                    cultureDescribedBy: cultureDescribedBy,
                    inModernCountry: inModernCountry,
                    wikipediaImagePage: wikipediaImagePage,
                    thumbnailURL: thumbnailURL 
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

        let thumbnailUrl = null;
        if (figure.thumbnailURL) {
            thumbnailUrl = figure.thumbnailURL;
        } else if (figure.wikipediaImagePage) {
            thumbnailUrl = await getWikimediaImageUrl(figure.wikipediaImagePage, 50); // Await the async call
        }

        if (thumbnailUrl) {
            const thumbnail = document.createElement('img');
            thumbnail.src = thumbnailUrl;
            thumbnail.style.width = '50px';
            thumbnail.style.height = 'auto';
            thumbnail.style.marginRight = '10px';
            figureItem.appendChild(thumbnail);
        }

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
            cultureDiv.classList.add('country-info');
            cultureDiv.style.fontSize = '0.8em';
            cultureDiv.textContent = `${figure.cultureLabel || figure.culture}`;
            textContainer.appendChild(cultureDiv);
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
const LOG_SCALE_THRESHOLD = -5000; // Dates before this will be compressed logarithmically
const LOG_SCALE_FACTOR = 6;         // Higher = more compression for early dates
const LOG_REGION_PROPORTION = 0.25;  // 0.4 = 40% of width for log region, adjust as needed


function timelineScale(date, minDate, maxDate) {
    // If all dates are after threshold, use linear only
    if (minDate >= LOG_SCALE_THRESHOLD) {
        return (date - minDate) / (maxDate - minDate);
    }
    // If all dates are before threshold, use log only
    if (maxDate < LOG_SCALE_THRESHOLD) {
        const logMin = Math.log(Math.abs(minDate - LOG_SCALE_THRESHOLD) + 1);
        const logMax = Math.log(Math.abs(maxDate - LOG_SCALE_THRESHOLD) + 1);
        const logVal = Math.log(Math.abs(date - LOG_SCALE_THRESHOLD) + 1);
        return (logVal - logMin) / (logMax - logMin);
    }

    // Hybrid: allocate LOG_REGION_PROPORTION to log region, rest to linear
    if (date < LOG_SCALE_THRESHOLD) {
        // Log region: scale to [0, LOG_REGION_PROPORTION]
        const logMin = Math.log(Math.abs(minDate - LOG_SCALE_THRESHOLD) + 1);
        const logMax = Math.log(1); // at threshold
        const logVal = Math.log(Math.abs(date - LOG_SCALE_THRESHOLD) + 1);
        return ((logVal - logMin) / (logMax - logMin)) * LOG_REGION_PROPORTION;
    } else {
        // Linear region: scale to [LOG_REGION_PROPORTION, 1]
        const linearMin = LOG_SCALE_THRESHOLD;
        const linearMax = maxDate;
        if (linearMax === linearMin) return 1; // avoid division by zero
        return LOG_REGION_PROPORTION + ((date - linearMin) / (linearMax - linearMin)) * (1 - LOG_REGION_PROPORTION);
    }
}

function renderTimelineScale(earliestDate, latestDate) {
    const scaleDiv = document.getElementById('figure-timeline-scale');
    scaleDiv.innerHTML = ''; // Clear previous scale

    // Decide tick values (years) based on range
    const ticks = [];
    const range = latestDate - earliestDate;

    // Major ticks: threshold, earliest, latest, and a few in between
    ticks.push(earliestDate);

    // Add threshold if in range
    if (earliestDate < LOG_SCALE_THRESHOLD && latestDate > LOG_SCALE_THRESHOLD) {
        ticks.push(LOG_SCALE_THRESHOLD);
    }

    // Add a few intermediate ticks (e.g., every 10,000 years before threshold, every 2,000 after)
    let stepBefore = 10000;
    let stepAfter = 2000;
    for (let y = Math.ceil(earliestDate / stepBefore) * stepBefore; y < LOG_SCALE_THRESHOLD; y += stepBefore) {
        if (y > earliestDate && y < LOG_SCALE_THRESHOLD) ticks.push(y);
    }
    for (let y = LOG_SCALE_THRESHOLD; y < latestDate; y += stepAfter) {
        if (y > LOG_SCALE_THRESHOLD && y < latestDate) ticks.push(y);
    }

    ticks.push(latestDate);

    // Remove duplicates and sort
    const uniqueTicks = Array.from(new Set(ticks)).sort((a, b) => a - b);

    // Render ticks
    uniqueTicks.forEach(year => {
        const percent = timelineScale(year, earliestDate, latestDate) * 100;
        const tickDiv = document.createElement('div');
        tickDiv.className = 'timeline-tick';
        tickDiv.style.left = `${percent}%`;
        tickDiv.style.height = '100%';

        const label = document.createElement('div');
        label.className = 'timeline-tick-label';
        label.textContent = formatDateForDisplay(year);
        label.style.left = '0';

        tickDiv.appendChild(label);
        scaleDiv.appendChild(tickDiv);
    });
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

    renderTimelineScale(earliestDate, latestDate);

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
        detailInfo.innerHTML = '';
        detailImageDiv.innerHTML = '';

        let detailImageUrl = null;
        if (figure.thumbnailURL) {
            detailImageUrl = figure.thumbnailURL;
        } else if (figure.wikipediaImagePage) {
            detailImageUrl = await getWikimediaImageUrl(figure.wikipediaImagePage, 200); // Await the async call
        }

        if (detailImageUrl) {
            const thumbnail = document.createElement('img');
            thumbnail.src = detailImageUrl;
            thumbnail.classList.add('detail-image-style');
            detailImageDiv.appendChild(thumbnail);
        }

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

        if (figure.date !== null) {
            detailInfo.innerHTML += `<p><strong>Date:</strong> ${formatDateForDisplay(figure.date)}</p>`;
        }
        if (figure.approximateDate !== null ) {
            detailInfo.innerHTML += `<p><strong>Approximate Date:</strong> ${formatDateForDisplay(figure.approximateDate)}</p>`;
        }
        if (figure.earliestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Earliest Date:</strong> ${formatDateForDisplay(figure.earliestDate)}</p>`;
        }
        
        if (figure.latestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Latest Date:</strong> ${formatDateForDisplay(figure.latestDate)}</p>`;
        }

        if (figure.describedBy) {
            const describedByLink = document.createElement('p');
            const link = document.createElement('a');
            link.href = figure.describedBy;
            link.textContent = 'More information';
            link.target = '_blank';
            describedByLink.appendChild(link);
            detailInfo.appendChild(describedByLink);
        }

        if (figure.note) {
            detailInfo.innerHTML += `<p><strong>Note:</strong> ${figure.note}</p>`;
        }

        const directLink = document.createElement('p');
        const link = document.createElement('a');
        link.href = `/#${figure.id}`;
        link.textContent = 'Direct Link';
        link.target = '_blank';
        directLink.appendChild(link);
        detailInfo.appendChild(directLink);

    } else {
        console.error("Figure details not found for ID:", figureId);
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

    renderFiguresAsList(sortedFiguresIndex);
    renderFiguresAsTimeline(sortedFiguresIndex);

    // --- Add this block ---
    // Check for hash in URL and show that figure if present and valid
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


// Tab functionality for the UI
// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const timelineScale = document.getElementById('figure-timeline-scale');
    const playBtn = document.getElementById('timeline-play-btn');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove 'active' from all
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            // Add 'active' to clicked button and corresponding content
            button.classList.add('active');
            const tabName = button.getAttribute('data-tab');
            const activeContent = document.getElementById(`${tabName}-container`);
            if (activeContent) {
                activeContent.classList.add('active');
            }

            // Show/hide the timeline scale
            if (tabName === 'figure-timeline') {
                timelineScale.classList.add('active');
            } else {
                timelineScale.classList.remove('active');
            }

            // Show/hide the play button
            if (button.getAttribute('data-tab') === 'figure-timeline') {
                playBtn.style.display = '';
            } else {
                playBtn.style.display = 'none';
                stopTimelinePlayback();
            }

            // --- Scroll to current figure in the relevant view ---
            if (tabName === 'figure-list' && currentFigureId) {
                scrollToListFigure(currentFigureId);
            } else if (tabName === 'figure-timeline' && currentFigureId) {
                scrollToTimelineFigure(currentFigureId);
                highlightTimelineFigure(currentFigureId);
            }
            // ------------------------------------------------------
        });
    });

    playBtn.addEventListener('click', () => {
        if (playBtn.dataset.playing === "true") {
            stopTimelinePlayback();
        } else {
            startTimelinePlayback();
        }
    });
});

function scrollToListFigure(figureId) {
    const currentDiv = document.getElementById(`list-${figureId}`);
    if (currentDiv) {
        currentDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
        console.warn(`Element with ID list-${figureId} not found.`);
    }
}

function scrollToTimelineFigure(figureId) {
    const currentDiv = document.getElementById(`timeline-${figureId}`);
    if (currentDiv) {
        currentDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

function startTimelinePlayback() {
    const playBtn = document.getElementById('timeline-play-btn');
    playBtn.textContent = '⏸️';
    playBtn.dataset.playing = "true";

    const timelineTab = document.getElementById('figure-timeline-container');
    let figures = [];
    if (timelineTab && timelineTab.classList.contains('active')) {
        figures = Array.from(document.querySelectorAll('.timeline-figure')).map(div => div.dataset.figureId);
        if (!figures.length && typeof currentSortedIndex !== "undefined") {
            figures = currentSortedIndex;
        }
    } else if (typeof currentSortedIndex !== "undefined") {
        figures = currentSortedIndex;
    }

    if (!figures.length) return;

    // Start from the current figure if available
    let startIndex = 0;
    if (currentFigureId) {
        const idx = figures.indexOf(currentFigureId);
        if (idx !== -1) startIndex = idx;
    }
    timelinePlayIndex = startIndex;

    showFigureDetails(figures[timelinePlayIndex]);
    scrollToTimelineFigure(figures[timelinePlayIndex]);
    highlightTimelineFigure(figures[timelinePlayIndex]);

    timelinePlayInterval = setInterval(() => {
        timelinePlayIndex++;
        if (timelinePlayIndex >= figures.length) {
            stopTimelinePlayback();
            return;
        }
        showFigureDetails(figures[timelinePlayIndex]);
        highlightTimelineFigure(figures[timelinePlayIndex]);
        scrollToTimelineFigure(figures[timelinePlayIndex]);
    }, 2000);
}

function stopTimelinePlayback() {
    const playBtn = document.getElementById('timeline-play-btn');
    playBtn.textContent = '▶️';
    playBtn.dataset.playing = "false";
    if (timelinePlayInterval) {
        clearInterval(timelinePlayInterval);
        timelinePlayInterval = null;
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
