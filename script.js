const turtleUrl = 'gaerhf.ttl';
const figureListDiv = document.getElementById('figure-list');
const figureDetailsDiv = document.getElementById('figure-details');
const detailLabel = document.getElementById('detail-label');
const detailInfo = document.getElementById('detail-info');
const detailImageDiv = document.getElementById('detail-image');
// const backToListButton = document.getElementById('back-to-list');

async function convertTurtleToJsonLd(turtleData) {
    const store = $rdf.graph();
    const contentType = 'text/turtle';
    const baseUrl = document.location.href; // Or a specific base URL if needed

    try {
        console.log("Parsing Turtle data...");
        await $rdf.parse(turtleData, store, baseUrl, contentType);
        console.log("Number of triples in store:", store.statements.length);

        // Serialize the store to JSON-LD using the function(err, str) callback
        $rdf.serialize(null, store, null, 'application/ld+json', function(err, jsonLdString) {
            if (err) {
                console.error("Serialization error (JSON-LD):", err);
                figureListDiv.textContent = 'Error serializing to JSON-LD.';
                return;
            }
            console.log("Serialized JSON-LD String (from callback):", jsonLdString);
            try {
                const jsonData = JSON.parse(jsonLdString);
                displayFigureList(jsonData); // Call display function here
            } catch (parseError) {
                console.error("Error parsing serialized JSON-LD:", parseError);
                figureListDiv.textContent = 'Error parsing serialized JSON-LD.';
            }
        });

        return null; // Serialization is asynchronous, result handled in callback
    } catch (error) {
        console.error("Error parsing Turtle:", error);
        figureListDiv.textContent = 'Error loading data.';
        return null;
    }
}

async function loadAndDisplayFigures() {
    try {
        console.log('Fetching:', turtleUrl);
        const response = await fetch(turtleUrl);
        console.log('Response:', response);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const turtleData = await response.text();
        console.log('Turtle Data:', turtleData);
        console.log("Converting Turtle to JSON-LD...");
        const jsonData = await convertTurtleToJsonLd(turtleData);
        if (jsonData) {
            displayFigureList(jsonData); // Pass the entire jsonData here
        }
    } catch (error) {
        console.error("Error in loadAndDisplayFigures:", error);
        figureListDiv.textContent = `Error loading or processing data: ${error.message}`;
    }
}

function displayFigureList(allSubjects) {
    figureListDiv.innerHTML = ''; // Clear loading message

    // Filter the subjects based on their @type
    const figuresToDisplay = allSubjects.filter(subject =>
        Array.isArray(subject['@type']) &&
        (subject['@type'].includes('urn:gaerhf:id:human-figure') ||
         subject['@type'].includes('urn:gaerhf:id:group-of-human-figures'))
    );

    // Sort the figures by earliest date
    figuresToDisplay.sort((a, b) => {
        const dateA = a['urn:gaerhf:id:earliest-date'] && a['urn:gaerhf:id:earliest-date'][0] && a['urn:gaerhf:id:earliest-date'][0]['@value'];
        const dateB = b['urn:gaerhf:id:earliest-date'] && b['urn:gaerhf:id:earliest-date'][0] && b['urn:gaerhf:id:earliest-date'][0]['@value'];

        if (dateA === undefined && dateB === undefined) return 0;
        if (dateA === undefined) return 1;
        if (dateB === undefined) return -1;

        return parseInt(dateA) - parseInt(dateB);
    });

    if (!figuresToDisplay || figuresToDisplay.length === 0) {
        figureListDiv.textContent = 'No human figures or groups found in the data.';
        return;
    }

    figuresToDisplay.forEach(figure => {
        const figureItem = document.createElement('div');
        figureItem.classList.add('figure-item');

        const label = figure['rdfs:label'] && figure['rdfs:label'][0] && figure['rdfs:label'][0]['@value'] ? figure['rdfs:label'][0]['@value'] : figure['@id'];
        const earliestDate = figure['urn:gaerhf:id:earliest-date'] && figure['urn:gaerhf:id:earliest-date'][0] && figure['urn:gaerhf:id:earliest-date'][0]['@value'];
        const latestDate = figure['urn:gaerhf:id:latest-date'] && figure['urn:gaerhf:id:latest-date'][0] && figure['urn:gaerhf:id:latest-date'][0]['@value'];

        // Attempt to get the culture label (assuming a gaerhf:art-historical-culture-or-tradition property)
        let cultureLabel = 'N/A';
        if (figure['urn:gaerhf:id:art-historical-culture-or-tradition'] && figure['urn:gaerhf:id:art-historical-culture-or-tradition'][0] && figure['urn:gaerhf:id:art-historical-culture-or-tradition'][0]['@id']) {
            const cultureId = figure['urn:gaerhf:id:art-historical-culture-or-tradition'][0]['@id'];
            // We need to find the label of this culture ID from the allSubjects array
            const cultureObject = allSubjects.find(item => item['@id'] === cultureId);
            if (cultureObject && cultureObject['rdfs:label'] && cultureObject['rdfs:label'][0] && cultureObject['rdfs:label'][0]['@value']) {
                cultureLabel = cultureObject['rdfs:label'][0]['@value'];
            }
        }

        let dateDisplay = '';
        if (earliestDate && latestDate) {
            dateDisplay = `(${earliestDate} - ${latestDate})`;
        } else if (earliestDate) {
            dateDisplay = `(${earliestDate})`;
        }

        figureItem.innerHTML = `
            <h3>${label}</h3>
            ${cultureLabel !== 'N/A' ? `<p class="culture">${cultureLabel}</p>` : ''}
            ${dateDisplay ? `<p class="date">${dateDisplay}</p>` : ''}
        `;
        figureItem.addEventListener('click', () => showFigureDetails(figure));
        figureListDiv.appendChild(figureItem);
    });
}

function showFigureDetails(figure) {
    detailLabel.textContent = figure['rdfs:label'] ? figure['rdfs:label'][0]['@value'] : figure['@id'];
    detailInfo.innerHTML = '';

    const earliestDate = figure['urn:gaerhf:id:earliest-date'] ? figure['urn:gaerhf:id:earliest-date'][0]['@value'] : 'N/A';
    const latestDate = figure['urn:gaerhf:id:latest-date'] ? figure['urn:gaerhf:id:latest-date'][0]['@value'] : 'N/A';
    const describedBy = figure['urn:gaerhf:id:described-by'] ? figure['urn:gaerhf:id:described-by'].map(item => `<a href="${item['@id']}" target="_blank">Link</a>`).join(', ') : 'N/A';
    const wikipediaImagePage = figure['urn:gaerhf:id:wikipedia-image-page'] ? figure['urn:gaerhf:id:wikipedia-image-page'][0]['@id'] : null;

    detailInfo.innerHTML += `<p><strong>Earliest Date:</strong> ${earliestDate}</p>`;
    detailInfo.innerHTML += `<p><strong>Latest Date:</strong> ${latestDate}</p>`;
    detailInfo.innerHTML += `<p><strong>Described By:</strong> ${describedBy}</p>`;

    detailImageDiv.innerHTML = '';
    if (wikipediaImagePage) {
        // **Important:** Directly using a Wikipedia image page URL won't display the image.
        // You would need to find the actual image URL from that page using the Wikipedia API
        // or a server-side proxy. For this client-side example, we'll just link to the page.
        const imageLink = document.createElement('a');
        imageLink.href = wikipediaImagePage;
        imageLink.target = '_blank';
        imageLink.textContent = 'View Image Page';
        detailImageDiv.appendChild(imageLink);
    } else {
        detailImageDiv.innerHTML = '<p>No image page available.</p>';
    }

    figureListDiv.classList.add('hidden');
    figureDetailsDiv.classList.remove('hidden');
}

// backToListButton.addEventListener('click', () => {
//     figureDetailsDiv.classList.add('hidden');
//     figureListDiv.classList.remove('hidden');
// });

// Load and display the figures when the script runs
loadAndDisplayFigures();