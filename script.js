const turtleUrl = 'gaerhf.ttl';
const figureListDiv = document.getElementById('figure-list');
const figureDetailsDiv = document.getElementById('figure-details');
const detailLabel = document.getElementById('detail-label');
const detailInfo = document.getElementById('detail-info');
const detailImageDiv = document.getElementById('detail-image');
const headerContainer = document.getElementById('header-container');

let figuresDict = {};
let kb;

function formatDateForDisplay(date) {
    if (date === null) {
        return '';
    }
    const year = Math.abs(date);
    const era = date < 0 ? ' BCE' : ' CE';
    return `${year}${era}`;
}

async function initializeStore($rdf) {
    kb = $rdf.graph();
    try {
        const response = await fetch(turtleUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const turtleData = await response.text();

        const contentType = 'text/turtle';
        const baseUrl = document.location.href;
        await $rdf.parse(turtleData, kb, baseUrl, contentType);
        console.log("Number of triples in kb:", kb.statements.length);
        return true;
    } catch (error) {
        console.error("Error initializing store:", error);
        figureListDiv.textContent = `Error loading or processing data: ${error.message}`;
        return false;
    }
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

async function buildFiguresDict($rdf) {
    const figureType = $rdf.sym('urn:gaerhf:id:human-figure');
    const groupType = $rdf.sym('urn:gaerhf:id:group-of-human-figures');
    const rdfType = $rdf.sym('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const earliestDateProp = $rdf.sym('urn:gaerhf:id:earliest-date');
    const latestDateProp = $rdf.sym('urn:gaerhf:id:latest-date');
    const approximateDateProp = $rdf.sym('urn:gaerhf:id:approximate-date');
    const rdfsLabelProp = $rdf.sym('http://www.w3.org/2000/01/rdf-schema#label');
    const cultureProp = $rdf.sym('urn:gaerhf:id:art-historical-culture-or-tradition');
    const wikipediaImagePageProp = $rdf.sym('urn:gaerhf:id:wikimedia-commons-image-page');
    const describedByProp = $rdf.sym('urn:gaerhf:id:described-by');
    const thumbnailImageProp = $rdf.sym('urn:gaerhf:id:thumbnail-image'); // New property

    const processedDict = {};

    try {
        [figureType, groupType].forEach(async type => {
            const subjectsOfType = kb.each(null, rdfType, type);
            console.log("Found subjects of type:", type.uri, "Count:", subjectsOfType.length);

            await Promise.all(subjectsOfType.map(async subject => {
                const shortId = subject.uri.replace('urn:gaerhf:id:', '');

                const earliestDateStr = kb.anyValue(subject, earliestDateProp);
                const latestDateStr = kb.anyValue(subject, latestDateProp);
                const approximateDateStr = kb.anyValue(subject, approximateDateProp);
                const label = kb.anyValue(subject, rdfsLabelProp);
                const earliestDate = earliestDateStr ? parseFloat(earliestDateStr) : null;
                const latestDate = latestDateStr ? parseFloat(latestDateStr) : null;
                const approximateDate = approximateDateStr ? parseFloat(approximateDateStr) : null;
                const culture = kb.any(subject, cultureProp);
                let cultureShortId = null;
                let cultureLabel = null;
                const wikipediaImagePage = kb.anyValue(subject, wikipediaImagePageProp);
                const describedBy = kb.anyValue(subject, describedByProp);
                const explicitThumbnailURL = kb.anyValue(subject, thumbnailImageProp); // Get explicit thumbnail

                if (culture) {
                    cultureShortId = culture.uri.replace('urn:gaerhf:id:', '');
                    cultureLabel = kb.anyValue(culture, rdfsLabelProp);
                }

                processedDict[shortId] = {
                    id: shortId,
                    label: label || shortId,
                    earliestDate: earliestDate,
                    latestDate: latestDate,
                    approximateDate: approximateDate,
                    culture: cultureShortId,
                    cultureLabel: cultureLabel,
                    wikipediaImagePage: wikipediaImagePage,
                    describedBy: describedBy,
                    explicitThumbnailURL: explicitThumbnailURL // Store explicit thumbnail URL
                };
            }));
        });
        console.log("Final processedDict:", processedDict);
        return processedDict;
    } catch (error) {
        console.error("Error processing store:", error);
        return {};
    }
}

function sortFigures(figures_local) {
    const figuresArray = Object.values(figures_local);

    figuresArray.sort((a, b) => {
        let dateA = a.earliestDate;
        let dateB = b.earliestDate;

        if (dateA === null && a.approximateDate !== null) {
            dateA = a.approximateDate;
        }
        if (dateB === null && b.approximateDate !== null) {
            dateB = b.approximateDate;
        }

        if (dateA !== null && dateB !== null) {
            return dateA - dateB;
        } else if (dateA !== null) {
            return -1;
        } else if (dateB !== null) {
            return 1;
        } else {
            const labelA = a.label || a.id;
            const labelB = b.label || b.id;
            return labelA.localeCompare(labelB);
        }
    });

    return figuresArray;
}

function renderFigures(figuresArray) {
    figureListDiv.innerHTML = '';
    if (!figuresArray || figuresArray.length === 0) {
        figureListDiv.textContent = 'No human figures or groups found.';
        return;
    }

    figuresArray.forEach(figure => {
        const figureItem = document.createElement('div');
        figureItem.classList.add('figure-item');
        figureItem.style.display = 'flex';
        figureItem.style.alignItems = 'center';

        let thumbnailUrl = null;
        if (figure.explicitThumbnailURL) {
            thumbnailUrl = figure.explicitThumbnailURL;
        } else if (figure.wikipediaImagePage) {
            thumbnailUrl = getWikimediaImageUrlSync(figure.wikipediaImagePage, 50);
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
        const labelSpan = document.createElement('span');
        labelSpan.textContent = figure.label || figure.id;
        textContainer.appendChild(labelSpan);

        if (figure.cultureLabel || figure.culture) {
            const cultureDiv = document.createElement('div');
            cultureDiv.classList.add('culture-info');
            cultureDiv.style.fontSize = '0.8em';
            cultureDiv.textContent = `(${figure.cultureLabel || figure.culture})`;
            textContainer.appendChild(cultureDiv);
        }

        figureItem.appendChild(textContainer);
        figureItem.addEventListener('click', () => {
            showFigureDetails(figure.id);
        });
        figureListDiv.appendChild(figureItem);
    });
}

function getWikimediaImageUrlSync(pageUrl, width = 200) {
    try {
        const parts = pageUrl.split('/');
        const filename = parts[parts.length - 1];
        const apiUrlBase = 'https://commons.wikimedia.org/w/api.php';
        const apiUrl = `${apiUrlBase}?action=query&prop=imageinfo&iiprop=url|thumburl&titles=${filename}&iiurlwidth=${width}&format=json&origin=*`;

        const xhr = new XMLHttpRequest();
        xhr.open('GET', apiUrl, false); // Synchronous request
        xhr.send();

        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];
            if (pageId !== "-1" && pages[pageId].imageinfo && pages[pageId].imageinfo[0].thumburl) {
                return pages[pageId].imageinfo[0].thumburl;
            } else {
                console.error("Could not retrieve thumbnail URL from the API response for:", pageUrl);
                return null;
            }
        } else {
            console.error(`Error fetching image info (sync): ${xhr.status} - ${xhr.statusText}`);
            return null;
        }
    } catch (error) {
        console.error("An error occurred while fetching Wikimedia image info (sync):", error);
        return null;
    }
}

function showFigureDetails(figureId) {
    const figure = figuresDict[figureId];
    if (figure && headerContainer) {
        detailLabel.textContent = figure.label || figure.id;
        detailInfo.innerHTML = '';
        detailImageDiv.innerHTML = '';

        let detailImageUrl = null;
        if (figure.explicitThumbnailURL) {
            detailImageUrl = figure.explicitThumbnailURL;
        } else if (figure.wikipediaImagePage) {
            detailImageUrl = getWikimediaImageUrlSync(figure.wikipediaImagePage, 200);
        }

        if (detailImageUrl) {
            const thumbnail = document.createElement('img');
            thumbnail.src = detailImageUrl;
            thumbnail.classList.add('detail-image-style');
            detailImageDiv.appendChild(thumbnail);
        }

        // **The following code was missing - it's now restored**
        if (figure.cultureLabel) {
            detailInfo.innerHTML += `<p><strong>Culture:</strong> ${figure.cultureLabel} (${figure.culture})</p>`;
        } else if (figure.culture) {
            detailInfo.innerHTML += `<p><strong>Culture:</strong> ${figure.culture}</p>`;
        }
        if (figure.earliestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Earliest Date:</strong> ${formatDateForDisplay(figure.earliestDate)}</p>`;
        }
        if (figure.approximateDate !== null && figure.earliestDate === null) {
            detailInfo.innerHTML += `<p><strong>Approximate Date:</strong> ${formatDateForDisplay(figure.approximateDate)}</p>`;
        } else if (figure.approximateDate !== null && figure.earliestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Approximate Date:</strong> ${formatDateForDisplay(figure.approximateDate)}</p>`;
        }
        if (figure.latestDate !== null) {
            detailInfo.innerHTML += `<p><strong>Latest Date:</strong> ${formatDateForDisplay(figure.latestDate)}</p>`;
        }

        if (figure.describedBy) {
            const describedByLink = document.createElement('p');
            const link = document.createElement('a');
            link.href = figure.describedBy;
            link.textContent = 'Further Description';
            link.target = '_blank'; // Open in a new tab
            describedByLink.appendChild(document.createTextNode('Description: '));
            describedByLink.appendChild(link);
            detailInfo.appendChild(describedByLink);
        }

    } else {
        console.error("Figure details not found for ID:", figureId);
    }
}

function getWikimediaImageUrlSync(pageUrl, width = 200) {
    try {
        const parts = pageUrl.split('/');
        const filename = parts[parts.length - 1];
        const apiUrlBase = 'https://commons.wikimedia.org/w/api.php';
        const apiUrl = `${apiUrlBase}?action=query&prop=imageinfo&iiprop=url|thumburl&titles=${filename}&iiurlwidth=${width}&format=json&origin=*`;

        const xhr = new XMLHttpRequest();
        xhr.open('GET', apiUrl, false); // Synchronous request
        xhr.send();

        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];
            if (pageId !== "-1" && pages[pageId].imageinfo && pages[pageId].imageinfo[0].thumburl) {
                return pages[pageId].imageinfo[0].thumburl;
            } else {
                console.error("Could not retrieve thumbnail URL from the API response for:", pageUrl);
                return null;
            }
        } else {
            console.error(`Error fetching image info (sync): ${xhr.status} - ${xhr.statusText}`);
            return null;
        }
    } catch (error) {
        console.error("An error occurred while fetching Wikimedia image info (sync):", error);
        return null;
    }
}

async function loadAndDisplayFigures($rdf) {
    if (await initializeStore($rdf)) {
        figuresDict = await buildFiguresDict($rdf);
        console.log("figuresDict item after build (in loadAndDisplay):", figuresDict['olmec-standing-figure']);
        console.log("figuresDict BEFORE sort:", figuresDict); // ADD THIS LOG

        const figuresDictStringified = JSON.stringify(figuresDict);
        const figuresDictParsed = JSON.parse(figuresDictStringified);

        const sortedFiguresForDisplay = sortFigures(figuresDictParsed); // Use the parsed object
        console.log("Contents of figuresDict (after sort call): ", figuresDictParsed);
        console.log("Contents of sortedFigures: ", sortedFiguresForDisplay)
        renderFigures(sortedFiguresForDisplay);
        if (sortedFiguresForDisplay.length > 0) {
            showFigureDetails(sortedFiguresForDisplay[0].id);
        }
    }
}

// Initialization sequence
loadAndDisplayFigures($rdf);