// Server Import Functionality
// Handles browsing server directories and importing images

let currentDatasetId = null;
let currentServerPath = '/data/ducbm3/DocumentOCR/dataset_public';
// Renamed to avoid conflict with app.js selectedFiles
let selectedServerFiles = new Set();

// Initialize server import modal
let isInitialized = false;

function initServerImport() {
    console.log('initServerImport called');

    // Prevent multiple initializations (optional, but good practice since app.js also calls it)
    if (isInitialized) {
        console.log('Server import already initialized, skipping re-bind.');
        return;
    }

    const importBtn = document.getElementById('importFromServerBtn');
    const modal = document.getElementById('serverImportModal');
    const closeBtn = document.getElementById('closeServerImportModal');
    const cancelBtn = document.getElementById('cancelServerImportBtn');
    const confirmBtn = document.getElementById('confirmServerImportBtn');
    const parentDirBtn = document.getElementById('parentDirBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');

    if (!importBtn) {
        console.error('Error: importFromServerBtn not found!');
        return;
    }
    if (!modal) {
        console.error('Error: serverImportModal not found!');
        return;
    }

    console.log('Binding click event to Import button');

    // Open modal
    importBtn.addEventListener('click', () => {
        console.log('Import button clicked');
        selectedServerFiles.clear();
        modal.classList.add('active');
        console.log('Modal active class added, browsing:', currentServerPath);
        browseDirectory(currentServerPath);
    });

    // Close modal
    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    // Go to parent directory
    parentDirBtn.addEventListener('click', () => {
        // Compute parent path client-side (e.g. /a/b/c → /a/b, / stays /)
        const parts = currentServerPath.replace(/\/+$/, '').split('/');
        parts.pop();
        const parentPath = parts.join('/') || '/';
        browseDirectory(parentPath);
    });

    // Select all images
    selectAllBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('.browser-item-checkbox');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);

        checkboxes.forEach(cb => {
            cb.checked = !allChecked;
            const item = cb.closest('.browser-item');
            if (cb.checked) {
                item.classList.add('selected');
                selectedServerFiles.add(item.dataset.name);
            } else {
                item.classList.remove('selected');
                selectedServerFiles.delete(item.dataset.name);
            }
        });

        updateSelectedCount();
    });

    // Confirm import
    confirmBtn.addEventListener('click', async () => {
        modal.classList.remove('active');
        await importSelectedFiles();
    });

    // Create loading overlay
    createLoadingOverlay();

    isInitialized = true;
    console.log('Server import initialization complete');
}

// Browse server directory
async function browseDirectory(path = null, goUp = false) {
    try {
        const targetPath = goUp ? null : (path || currentServerPath);

        const response = await fetch('/api/browse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath })
        });

        if (!response.ok) {
            throw new Error('Failed to browse directory');
        }

        const data = await response.json();
        currentServerPath = data.currentPath;

        renderDirectoryItems(data.items);
        document.getElementById('currentPath').textContent = data.currentPath;

    } catch (error) {
        console.error('Error browsing directory:', error);
        alert('Failed to browse directory: ' + error.message);
    }
}

// Render directory items
function renderDirectoryItems(items) {
    const browserList = document.getElementById('browserList');
    browserList.innerHTML = '';

    items.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = 'browser-item';
        if (item.isDirectory) {
            itemEl.classList.add('directory');
        }
        itemEl.dataset.name = item.name;
        itemEl.dataset.path = item.path;

        // Icon
        const iconSvg = item.isDirectory
            ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-8l-2-2H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="2"/></svg>'
            : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M4 16l4-4 3 3 5-5 4 4" stroke="currentColor" stroke-width="2"/></svg>';

        const iconClass = item.isDirectory ? 'directory' : 'image';

        // Format size
        const size = formatFileSize(item.size);

        // Check if it's an image file
        const isImage = !item.isDirectory && /\.(jpg|jpeg|png|gif|bmp|tiff|webp)$/i.test(item.name);

        // Checkbox availability: can select directory or image
        const isSelectable = item.isDirectory || isImage;

        itemEl.innerHTML = `
            <div class="browser-item-icon ${iconClass}">
                ${iconSvg}
            </div>
            <div class="browser-item-info">
                <div class="browser-item-name">${item.name}</div>
                <div class="browser-item-meta">${item.isDirectory ? 'Folder' : size}</div>
            </div>
            ${isSelectable ? '<input type="checkbox" class="browser-item-checkbox">' : ''}
        `;

        // Click handler
        if (isSelectable) {
            const checkbox = itemEl.querySelector('.browser-item-checkbox');

            itemEl.addEventListener('click', (e) => {
                // If clicked checkbox, don't navigate
                if (e.target === checkbox) return;

                // If clicked row (but not checkbox), navigate if directory
                if (item.isDirectory) {
                    browseDirectory(item.path);
                } else {
                    // Toggle selection for images
                    checkbox.checked = !checkbox.checked;
                    handleCheckboxChange(checkbox, item.name);
                }
            });

            checkbox.addEventListener('change', () => {
                handleCheckboxChange(checkbox, item.name);
            });
        }

        browserList.appendChild(itemEl);
    });
}

// Handle checkbox change
function handleCheckboxChange(checkbox, fileName) {
    const item = checkbox.closest('.browser-item');

    if (checkbox.checked) {
        item.classList.add('selected');
        selectedServerFiles.add(fileName);
    } else {
        item.classList.remove('selected');
        selectedServerFiles.delete(fileName);
    }

    updateSelectedCount();
}

// Update selected count
function updateSelectedCount() {
    const count = selectedServerFiles.size;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('confirmServerImportBtn').disabled = count === 0;
}

// Import selected files
async function importSelectedFiles() {
    if (selectedServerFiles.size === 0) return;

    // Show loading
    showLoading(`Starting import...`);
    startProgressPolling(currentDatasetId);

    try {
        const fileNames = Array.from(selectedServerFiles);

        const response = await fetch(`/api/datasets/${currentDatasetId}/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourcePath: currentServerPath,
                fileNames: fileNames
            })
        });

        if (!response.ok) {
            throw new Error('Failed to import files');
        }

        const importedFiles = await response.json();

        // Ensure polling stops and shows 100%
        stopProgressPolling(currentDatasetId);
        updateLoadingProgress(100, `Successfully imported ${importedFiles.length} images!`);

        // Refresh images list
        await loadImages(currentDatasetId);

        // --- Auto-label Discovery ---
        try {
            // Only scan the folders being imported
            const pathsToScan = fileNames.map(name => {
                // Construct joined path correctly
                return currentServerPath.endsWith('/') ? currentServerPath + name : currentServerPath + '/' + name;
            });

            const scanResponse = await fetch('/api/utils/scan-labels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: pathsToScan })
            });

            if (scanResponse.ok) {
                const scanData = await scanResponse.json();
                if (scanData.labels && scanData.labels.length > 0) {
                    // Check if there are new labels
                    const existingLabels = new Set(window.currentDataset.labels);
                    const newLabels = scanData.labels.filter(l => !existingLabels.has(l));

                    if (newLabels.length > 0) {
                        console.log('New labels discovered:', newLabels);
                        const updatedLabels = [...window.currentDataset.labels, ...newLabels];

                        // Update dataset in DB
                        const updateResponse = await fetch(`/api/datasets/${currentDatasetId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: window.currentDataset.name,
                                description: window.currentDataset.description,
                                labels: updatedLabels
                            })
                        });

                        if (updateResponse.ok) {
                            const updatedDataset = await updateResponse.json();
                            window.currentDataset = updatedDataset;

                            // Refresh label controls in UI (dropdown + filter panel)
                            if (typeof window.refreshLabelControls === 'function') {
                                window.refreshLabelControls();
                            }
                            console.log('Dataset labels updated automatically.');
                        }
                    }
                }
            }
        } catch (scanErr) {
            console.error('Error during auto-label scan:', scanErr);
        }
        // --- End Auto-label Discovery ---

        hideLoading();

        // Short timeout to allow UI to update before alert
        setTimeout(() => {
            alert(`Successfully imported ${importedFiles.length} images!`);
        }, 100);

        selectedServerFiles.clear();

    } catch (error) {
        stopProgressPolling(currentDatasetId);
        hideLoading();
        console.error('Error importing files:', error);
        alert('Failed to import files: ' + error.message);
    }
}

let progressInterval = null;

function startProgressPolling(datasetId) {
    if (progressInterval) clearInterval(progressInterval);

    // Initial poll
    pollProgress(datasetId);

    progressInterval = setInterval(() => {
        pollProgress(datasetId);
    }, 800);
}

function stopProgressPolling(datasetId) {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

async function pollProgress(datasetId) {
    try {
        const response = await fetch(`/api/datasets/${datasetId}/import-progress`);
        if (!response.ok) return;

        const data = await response.json();
        if (data.state === 'idle') return;

        let message = '';
        let percentage = 0;

        if (data.state === 'scanning') {
            message = 'Scanning directory for images...';
            percentage = 5; // Fake start
        } else if (data.state === 'importing') {
            percentage = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
            message = `Importing images: ${data.current} / ${data.total}`;
        } else if (data.state === 'finalizing') {
            percentage = 99;
            message = 'Finalizing dataset statistics...';
        } else if (data.state === 'completed') {
            percentage = 100;
            message = 'Import completed successfully!';
            stopProgressPolling(datasetId);
        } else if (data.state === 'failed') {
            message = 'Import failed: ' + (data.error || 'Unknown error');
            stopProgressPolling(datasetId);
        }

        updateLoadingProgress(percentage, message);
    } catch (e) {
        console.error('Error polling progress:', e);
    }
}

function updateLoadingProgress(percentage, message) {
    const overlay = document.getElementById('serverImportLoading');
    if (!overlay) return;

    const fill = overlay.querySelector('.progress-bar-fill');
    const pctText = overlay.querySelector('.progress-percentage');
    const label = overlay.querySelector('.loading-text');
    const spinner = overlay.querySelector('.spinner');

    if (label) label.textContent = message;
    if (fill) fill.style.width = `${percentage}%`;
    if (pctText) pctText.textContent = `${percentage}%`;

    // Hide spinner once we have actual progress
    if (spinner && percentage > 0) {
        spinner.style.display = 'none';
    }
}

// Format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Set current dataset ID (called when opening annotate view)
function setCurrentDatasetForImport(datasetId) {
    currentDatasetId = datasetId;
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initServerImport);
} else {
    initServerImport();
}

// Loading Overlay Functions
function createLoadingOverlay() {
    if (document.getElementById('serverImportLoading')) return;

    const overlay = document.createElement('div');
    overlay.id = 'serverImportLoading';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text">Importing files...</div>
        <div class="progress-container">
            <div class="progress-bar-fill"></div>
        </div>
        <div class="progress-percentage">0%</div>
    `;
    document.body.appendChild(overlay);
}

function showLoading(message = 'Loading...') {
    const overlay = document.getElementById('serverImportLoading');
    if (overlay) {
        overlay.querySelector('.loading-text').textContent = message;
        const fill = overlay.querySelector('.progress-bar-fill');
        const pctText = overlay.querySelector('.progress-percentage');
        const spinner = overlay.querySelector('.spinner');

        if (fill) fill.style.width = '0%';
        if (pctText) pctText.textContent = '0%';
        if (spinner) spinner.style.display = 'block';

        overlay.classList.add('active');
    }
}

function hideLoading() {
    const overlay = document.getElementById('serverImportLoading');
    if (overlay) {
        overlay.classList.remove('active');
    }
}
