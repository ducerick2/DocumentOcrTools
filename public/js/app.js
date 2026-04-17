// API Base URL
const API_BASE = '/api';

// Global State
let currentDataset = null;
let datasets = [];
window.duplicateModeActive = false; // Toggle for "Check Duplicate" mode
window.duplicateImageIds = new Set(); // Stores IDs of images with duplicates/containment

// DOM Elements
const datasetsView = document.getElementById('datasetsView');
const annotateView = document.getElementById('annotateView');
const exportView = document.getElementById('exportView');
const datasetsGrid = document.getElementById('datasetsGrid');
const emptyState = document.getElementById('emptyState');

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const view = item.dataset.view;
        switchView(view);
    });
});

function switchView(viewName) {
    // Update navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Update views
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });

    if (viewName === 'datasets') {
        datasetsView.classList.add('active');
    } else if (viewName === 'annotate') {
        annotateView.classList.add('active');
    } else if (viewName === 'export') {
        exportView.classList.add('active');
    }
}

// Load datasets on page load
async function loadDatasets() {
    try {
        const response = await fetch(`${API_BASE}/datasets`);
        datasets = await response.json();

        updateStats();
        renderDatasets();
    } catch (error) {
        console.error('Error loading datasets:', error);
    }
}

function updateStats() {
    const totalDatasets = datasets.length;
    const totalImages = datasets.reduce((sum, d) => sum + d.imageCount, 0);

    document.getElementById('totalDatasets').textContent = totalDatasets;
    document.getElementById('totalImages').textContent = totalImages;
}

function renderDatasets() {
    if (datasets.length === 0) {
        datasetsGrid.style.display = 'none';
        emptyState.classList.add('active');
        return;
    }

    datasetsGrid.style.display = 'grid';
    emptyState.classList.remove('active');

    datasetsGrid.innerHTML = datasets.map(dataset => `
    <div class="dataset-card" data-id="${dataset.id}">
      <div class="dataset-header">
        <div>
          <h3>${dataset.name}</h3>
        </div>
        <button class="dataset-menu" onclick="deleteDataset('${dataset.id}', event)">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 5h14M8 5V3h4v2M6 5v10a2 2 0 002 2h4a2 2 0 002-2V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      
      <p class="dataset-description">${dataset.description || 'No description'}</p>
      
      <div class="dataset-stats">
        <div class="dataset-stat">
          <span class="dataset-stat-value">${dataset.imageCount}</span>
          <span class="dataset-stat-label">Images</span>
        </div>
        <div class="dataset-stat">
          <span class="dataset-stat-value">${dataset.annotatedCount}</span>
          <span class="dataset-stat-label">Annotated</span>
        </div>
      </div>
      
      <div class="dataset-meta">
        <span class="dataset-type">${dataset.annotationType}</span>
        <span class="dataset-date">${new Date(dataset.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  `).join('');

    // Add click handlers
    document.querySelectorAll('.dataset-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (!e.target.closest('.dataset-menu')) {
                openDataset(card.dataset.id);
            }
        });
    });
}

// Create Dataset Modal
const createDatasetModal = document.getElementById('createDatasetModal');
const createDatasetForm = document.getElementById('createDatasetForm');

document.getElementById('createDatasetBtn').addEventListener('click', () => {
    createDatasetModal.classList.add('active');
});

document.getElementById('closeCreateModal').addEventListener('click', () => {
    createDatasetModal.classList.remove('active');
    createDatasetForm.reset();
});

document.getElementById('cancelCreateBtn').addEventListener('click', () => {
    createDatasetModal.classList.remove('active');
    createDatasetForm.reset();
});

// Auto-load labels toggle logic
const autoLoadToggle = document.getElementById('autoLoadLabelsToggle');
const datasetLabelsInput = document.getElementById('datasetLabels');
const labelsHint = document.getElementById('labelsHint');

if (autoLoadToggle) {
    autoLoadToggle.addEventListener('change', () => {
        if (autoLoadToggle.checked) {
            datasetLabelsInput.required = false;
            datasetLabelsInput.placeholder = "Labels will be added automatically on import";
            labelsHint.textContent = "Labels will be automatically discovered from annotations during import.";
            labelsHint.style.color = "var(--accent-primary)";
        } else {
            datasetLabelsInput.required = true;
            datasetLabelsInput.placeholder = "e.g., text, logo, signature";
            labelsHint.textContent = "Enter labels separated by commas";
            labelsHint.style.color = "var(--text-secondary)";
        }
    });
}

createDatasetForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('datasetName').value;
    const description = document.getElementById('datasetDescription').value;
    const annotationType = document.getElementById('annotationType').value;
    const labelsStr = datasetLabelsInput.value;
    const labels = labelsStr.split(',').map(l => l.trim()).filter(l => l);

    if (!autoLoadToggle.checked && labels.length === 0) {
        alert('Please provide at least one label or enable auto-load.');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/datasets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, annotationType, labels })
        });

        const newDataset = await response.json();
        datasets.push(newDataset);

        createDatasetModal.classList.remove('active');
        createDatasetForm.reset();

        // Reset toggle state
        datasetLabelsInput.required = true;
        datasetLabelsInput.placeholder = "e.g., text, logo, signature";
        labelsHint.textContent = "Enter labels separated by commas";
        labelsHint.style.color = "var(--text-secondary)";

        updateStats();
        renderDatasets();
    } catch (error) {
        console.error('Error creating dataset:', error);
        alert('Failed to create dataset');
    }
});

// Delete Dataset
const deleteConfirmModal = document.getElementById('deleteConfirmModal');
let datasetIdToDelete = null;

async function deleteDataset(id, event) {
    event.stopPropagation();
    datasetIdToDelete = id;
    deleteConfirmModal.classList.add('active');
}

document.getElementById('closeDeleteModal').addEventListener('click', () => {
    deleteConfirmModal.classList.remove('active');
    datasetIdToDelete = null;
});

document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
    deleteConfirmModal.classList.remove('active');
    datasetIdToDelete = null;
});

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!datasetIdToDelete) return;

    try {
        await fetch(`${API_BASE}/datasets/${datasetIdToDelete}`, {
            method: 'DELETE'
        });

        datasets = datasets.filter(d => d.id !== datasetIdToDelete);
        updateStats();
        renderDatasets();
        deleteConfirmModal.classList.remove('active');
        datasetIdToDelete = null;
    } catch (error) {
        console.error('Error deleting dataset:', error);
        alert('Failed to delete dataset');
    }
});

// Open Dataset for Annotation
async function openDataset(id) {
    try {
        const response = await fetch(`${API_BASE}/datasets/${id}`);
        currentDataset = await response.json();
        window.currentDataset = currentDataset; // Expose for annotator.js

        document.getElementById('annotateDatasetName').textContent = currentDataset.name;
        document.getElementById('annotateDatasetDesc').textContent = currentDataset.description || 'Annotate your images';

        // Populate label selector
        const labelSelect = document.getElementById('labelSelect');
        labelSelect.innerHTML = '<option value="">Select label...</option>' +
            currentDataset.labels.map(label => `<option value="${label}">${label}</option>`).join('');

        // Enable navigation
        document.querySelector('[data-view="annotate"]').disabled = false;

        switchView('annotate');
        loadImages();

        // Initialize server import after view is loaded
        if (typeof setCurrentDatasetForImport === 'function') {
            setCurrentDatasetForImport(id);
        }
        if (typeof initServerImport === 'function') {
            initServerImport();
        }
    } catch (error) {
        console.error('Error opening dataset:', error);
    }
}

// Back to Datasets
document.getElementById('backToDatasets').addEventListener('click', () => {
    switchView('datasets');
    loadDatasets();
});

document.getElementById('backToDatasets2').addEventListener('click', () => {
    switchView('datasets');
    loadDatasets();
});

// Upload Images Modal
const uploadImagesModal = document.getElementById('uploadImagesModal');
const uploadArea = document.getElementById('uploadArea');
const imageInput = document.getElementById('imageInput');
const uploadPreview = document.getElementById('uploadPreview');
const confirmUploadBtn = document.getElementById('confirmUploadBtn');

let selectedFiles = [];

document.getElementById('uploadImagesBtn').addEventListener('click', () => {
    uploadImagesModal.classList.add('active');
});

document.getElementById('excludeDataBtn').addEventListener('click', () => {
    if (typeof excludeCurrentImage === 'function') {
        excludeCurrentImage();
    } else {
        console.error('excludeCurrentImage function not found');
    }
});

document.getElementById('cleanDataBtn').addEventListener('click', async () => {
    if (!currentDataset) return;
    
    if (!confirm('Are you sure you want to clean this dataset? This will remove invalid, tiny, blank and duplicate annotations across ALL images.')) {
        return;
    }

    const overlay = document.getElementById('loadingOverlay');
    const loadingText = overlay ? overlay.querySelector('.loading-text') : null;
    const progressContainer = overlay ? overlay.querySelector('.progress-container') : null;
    const progressBarFill = overlay ? overlay.querySelector('.progress-bar-fill') : null;
    const progressPercentage = overlay ? overlay.querySelector('.progress-percentage') : null;

    if (overlay) overlay.classList.add('active');
    if (loadingText) loadingText.textContent = 'Cleaning dataset...';
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressPercentage) progressPercentage.style.display = 'block';
    if (progressBarFill) progressBarFill.style.width = '0%';
    if (progressPercentage) progressPercentage.textContent = '0%';

    try {
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/clean`, {
            method: 'POST'
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // Keep partial line for next iteration

            for (const line of lines) {
                if (!line.trim()) continue;
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        
                        if (data.progress) {
                            if (loadingText) loadingText.textContent = `Cleaning dataset (${data.current}/${data.total})...`;
                            if (progressBarFill) progressBarFill.style.width = `${data.progress}%`;
                            if (progressPercentage) progressPercentage.textContent = `${data.progress}%`;
                        }

                        if (data.success) {
                            const stats = data.stats;
                            alert(`Clean Up Successful!\n\n` +
                                  `- Out of bounds removed: ${stats.removedOutOfBounds}\n` +
                                  `- Tiny boxes removed: ${stats.removedTiny}\n` +
                                  `- White boxes removed: ${stats.removedWhite}\n` +
                                  `- Duplicates removed: ${stats.removedDuplicates}\n` +
                                  `- Total annotations removed: ${stats.totalRemoved}`);
                            if (window.clearAnnotationCache) window.clearAnnotationCache();
                            openDataset(currentDataset.id);
                        } else if (data.error) {
                            alert('Error cleaning dataset: ' + data.error);
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e, line);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error cleaning dataset:', error);
        alert('Error cleaning dataset: ' + error.message);
    } finally {
        if (overlay) overlay.classList.remove('active');
        if (loadingText) loadingText.textContent = 'Loading...';
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressPercentage) progressPercentage.style.display = 'none';
    }
});

document.getElementById('checkDuplicateBtn').addEventListener('click', async () => {
    if (!currentDataset) return;
    
    const btn = document.getElementById('checkDuplicateBtn');
    
    // Toggle OFF
    if (window.duplicateModeActive) {
        window.duplicateModeActive = false;
        window.duplicateImageIds.clear();
        btn.classList.remove('btn-duplicate-active');
        
        // Just remove the red border from all image items in the gallery without a full refresh
        document.querySelectorAll('.image-item').forEach(item => {
            item.classList.remove('duplicate-border');
        });
        return;
    }

    // Toggle ON
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = overlay ? overlay.querySelector('.loading-text') : null;
    const progressContainer = overlay ? overlay.querySelector('.progress-container') : null;
    const progressBarFill = overlay ? overlay.querySelector('.progress-bar-fill') : null;
    const progressPercentage = overlay ? overlay.querySelector('.progress-percentage') : null;

    if (overlay) overlay.classList.add('active');
    if (loadingText) loadingText.textContent = 'Scanning for duplicates...';
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressPercentage) progressPercentage.style.display = 'block';
    if (progressBarFill) progressBarFill.style.width = '0%';
    if (progressPercentage) progressPercentage.textContent = '0%';

    try {
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/check-duplicates`, {
            method: 'POST'
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        
                        if (data.progress) {
                            if (loadingText) loadingText.textContent = `Scanning (${data.current}/${data.total})...`;
                            if (progressBarFill) progressBarFill.style.width = `${data.progress}%`;
                            if (progressPercentage) progressPercentage.textContent = `${data.progress}%`;
                        }

                        if (data.success) {
                            window.duplicateImageIds = new Set(data.problematicImageIds.map(id => String(id)));
                            window.duplicateModeActive = true;
                            btn.classList.add('btn-duplicate-active');
                            
                            // Use setTimeout to allow UI to render the 100% progress before blocking alert
                            setTimeout(() => {
                                if (duplicateImageIds.size === 0) {
                                    alert('Great! No duplicate or overlapping boxes found in this dataset.');
                                    duplicateModeActive = false;
                                    btn.classList.remove('btn-duplicate-active');
                                } else {
                                    alert(`Scan complete! Found ${duplicateImageIds.size} images with overlapping boxes. Check the red-bordered cards in the side gallery.`);
                                }
                                renderImages(); // Refresh gallery to show borders
                                if (overlay) overlay.classList.remove('active');
                            }, 100);
                            return; // Success handled
                        } else if (data.error) {
                            setTimeout(() => {
                                alert('Scanning failed: ' + data.error);
                                if (overlay) overlay.classList.remove('active');
                            }, 100);
                            return;
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error scanning duplicates:', error);
        alert('Scanning failed: ' + error.message);
    } finally {
        // Delay hiding the overlay slightly to ensure 100% progress is visible
        setTimeout(() => {
            if (overlay && overlay.classList.contains('active')) {
                overlay.classList.remove('active');
            }
            if (loadingText) loadingText.textContent = 'Loading...';
            if (progressContainer) progressContainer.style.display = 'none';
            if (progressPercentage) progressPercentage.style.display = 'none';
        }, 300);
    }
});

function renderImages() {
    // This is often just a call to loadImages or a specialized local renderer
    // In this app.js, the actual rendering is inside loadImages()'s renderChunk.
    // I will call loadImages() to refresh the entire view.
    loadImages();
}

document.getElementById('closeUploadModal').addEventListener('click', () => {
    uploadImagesModal.classList.remove('active');
    selectedFiles = [];
    uploadPreview.innerHTML = '';
    confirmUploadBtn.disabled = true;
});

document.getElementById('cancelUploadBtn').addEventListener('click', () => {
    uploadImagesModal.classList.remove('active');
    selectedFiles = [];
    uploadPreview.innerHTML = '';
    confirmUploadBtn.disabled = true;
});

uploadArea.addEventListener('click', () => {
    imageInput.click();
});

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = 'var(--accent-primary)';
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = 'var(--border-color)';
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = 'var(--border-color)';
    handleFiles(e.dataTransfer.files);
});

imageInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

function handleFiles(files) {
    selectedFiles = Array.from(files);

    uploadPreview.innerHTML = selectedFiles.map((file, idx) => {
        const url = URL.createObjectURL(file);
        return `
      <div class="upload-preview-item">
        <img src="${url}" alt="${file.name}">
      </div>
    `;
    }).join('');

    confirmUploadBtn.disabled = selectedFiles.length === 0;
}

confirmUploadBtn.addEventListener('click', async () => {
    if (!currentDataset || selectedFiles.length === 0) return;

    const formData = new FormData();
    selectedFiles.forEach(file => {
        formData.append('images', file);
    });

    try {
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/images`, {
            method: 'POST',
            body: formData
        });

        await response.json();

        uploadImagesModal.classList.remove('active');
        selectedFiles = [];
        uploadPreview.innerHTML = '';
        confirmUploadBtn.disabled = true;
        imageInput.value = '';

        loadImages();
        loadDatasets(); // Refresh stats
    } catch (error) {
        console.error('Error uploading images:', error);
        alert('Failed to upload images');
    }
});

// Load Images
async function loadImages() {
    if (!currentDataset) return;

    try {
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/images`);
        const images = await response.json();
        window.datasetImages = images; // Expose for annotator.js

        const imagesList = document.getElementById('imagesList');
        document.getElementById('imageCount').textContent = images.length;

        if (images.length === 0) {
            imagesList.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">No images yet</div>';
            return;
        }

        let renderedCount = 0;

        // Global helper to jump to a specific index
        window.jumpToImage = function(index) {
            if (!window.datasetImages || !window.datasetImages[index]) return;
            
            const imagesList = document.getElementById('imagesList');
            const items = imagesList.querySelectorAll('.image-item');
            
            // Helper function to handle the actual loading
            const executeJump = (item) => {
                const activeItem = document.querySelector('.image-item.active');
                if (activeItem) activeItem.classList.remove('active');
                item.classList.add('active');
                item.scrollIntoView({ block: 'nearest' });
                loadImageInCanvas(item.dataset.path, item.dataset.id);
            };

            if (items[index]) {
                executeJump(items[index]);
            } else {
                // Item might not be rendered yet (lazy loading), wait for it
                const checkAndLoad = () => {
                    const currentItems = imagesList.querySelectorAll('.image-item');
                    if (currentItems[index]) {
                        executeJump(currentItems[index]);
                    } else if (renderedCount <= index && renderedCount < window.datasetImages.length) {
                        requestAnimationFrame(checkAndLoad);
                    }
                };
                checkAndLoad();
            }
        };

        // Existing sidebar search functionality
        const searchInput = document.getElementById('searchImageInput');
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const query = searchInput.value.trim().toLowerCase();
                    if (!query) return;

                    const index = images.findIndex(img => 
                        img.filename.toLowerCase().includes(query)
                    );

                    if (index !== -1) {
                        window.jumpToImage(index);
                    } else {
                        searchInput.style.color = '#ef4444';
                        setTimeout(() => searchInput.style.color = '', 1000);
                    }
                }
            });
        }

        // New status bar search functionality
        const statusSearchInput = document.getElementById('statusSearchInput');
        if (statusSearchInput) {
            statusSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const query = statusSearchInput.value.trim().toLowerCase();
                    if (!query) return;

                    const index = images.findIndex(img => 
                        img.filename.toLowerCase().includes(query)
                    );

                    if (index !== -1) {
                        window.jumpToImage(index);
                        statusSearchInput.value = ''; // Optional: clear after jump
                        statusSearchInput.blur();
                    } else {
                        statusSearchInput.style.color = '#ef4444';
                        setTimeout(() => statusSearchInput.style.color = '', 1000);
                    }
                }
            });
        }

        // Check for Resume Progress
        const lastIndexKey = `lastImageIndex_${currentDataset.id}`;
        const lastIndex = localStorage.getItem(lastIndexKey);

        if (lastIndex !== null && images[lastIndex]) {
            const index = parseInt(lastIndex);

            // Show Resume Modal
            const resumeModal = document.getElementById('resumeModal');
            const lastImageIndexSpan = document.getElementById('lastImageIndex');
            const totalImagesCountSpan = document.getElementById('totalImagesCount');
            const resumeIndexBtnText = document.getElementById('resumeIndexBtnText');
            const resumeProgressPercent = document.getElementById('resumeProgressPercent');
            const resumeProgressBar = document.getElementById('resumeProgressBar');

            lastImageIndexSpan.textContent = index + 1;
            totalImagesCountSpan.textContent = images.length;
            resumeIndexBtnText.textContent = index + 1;

            // Calculate progress
            const progress = Math.round(((index + 1) / images.length) * 100);
            resumeProgressPercent.textContent = `${progress}%`;

            resumeModal.classList.add('active');

            // Animate progress bar slightly after modal shows
            setTimeout(() => {
                resumeProgressBar.style.width = `${progress}%`;
            }, 100);

            // Buttons
            const resumeBtn = document.getElementById('resumeProgressBtn');
            const startOverBtn = document.getElementById('startFromBeginningBtn');

            // Clear previous listeners to avoid duplicates
            const newResumeBtn = resumeBtn.cloneNode(true);
            const newStartOverBtn = startOverBtn.cloneNode(true);
            resumeBtn.parentNode.replaceChild(newResumeBtn, resumeBtn);
            startOverBtn.parentNode.replaceChild(newStartOverBtn, startOverBtn);

            newResumeBtn.addEventListener('click', () => {
                resumeModal.classList.remove('active');
                window.jumpToImage(index);
            });

            newStartOverBtn.addEventListener('click', () => {
                resumeModal.classList.remove('active');
                localStorage.removeItem(lastIndexKey);
                window.jumpToImage(0);
            });
        } else {
            // No progress saved or invalid index, just load the first one
            window.jumpToImage(0);
        }

        // Use lazy loading for images
        // Incremental Rendering to avoid freezing UI
        imagesList.innerHTML = '';
        const chunkSize = 50;

        const renderChunk = () => {
            const chunk = images.slice(renderedCount, renderedCount + chunkSize);
            if (chunk.length === 0) return;

            const html = chunk.map((img, index) => {
                const globalIndex = renderedCount + index;
                // Use thumbnail endpoint for list
                const thumbnailUrl = `${API_BASE}/datasets/${currentDataset.id}/thumbnails/${img.filename}`;
                
                // Add duplicate-border highlight if mode is active and image has issues
                const duplicateClass = (duplicateModeActive && duplicateImageIds.has(String(img.id))) ? 'duplicate-border' : '';

                return `
      <div class="image-item ${duplicateClass}" data-id="${img.id}" data-path="${img.path}">
        <div class="image-number" style="position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.6); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; z-index: 10;">${globalIndex + 1}</div>
        <img src="${thumbnailUrl}" alt="${img.filename}" loading="lazy" 
             onerror="this.onerror=null; this.src='${img.path}'; this.parentElement.onerror=()=>this.src='https://placehold.co/200x200?text=Error';">
        <div class="image-item-overlay">${img.filename}</div>
      </div>
    `}).join('');

            imagesList.insertAdjacentHTML('beforeend', html);

            // Add click handlers for new items
            const newItems = imagesList.querySelectorAll('.image-item:not(.has-handler)');
            newItems.forEach(item => {
                item.classList.add('has-handler'); // Mark as handled
                item.addEventListener('click', () => {
                    const activeItem = document.querySelector('.image-item.active');
                    if (activeItem) activeItem.classList.remove('active');
                    item.classList.add('active');
                    loadImageInCanvas(item.dataset.path, item.dataset.id);
                });
            });

            renderedCount += chunkSize;

            if (renderedCount < images.length) {
                requestAnimationFrame(renderChunk);
            }
        };

        renderChunk();


    } catch (error) {
        console.error('Error loading images:', error);
    }
}

// Export functionality
document.querySelectorAll('[data-format]').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!currentDataset) return;

        const format = btn.dataset.format;

        try {
            const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/export/${format}`);
            const data = await response.json();

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${currentDataset.name}_${format}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error exporting:', error);
            alert('Failed to export dataset');
        }
    });
});

// Initialize
loadDatasets();

// Sidebar Toggle
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const sidebar = document.querySelector('.sidebar');

if (toggleSidebarBtn && sidebar) {
    toggleSidebarBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
    });
}

// Global UI Refreshers
// Global UI Refreshers
window.refreshLabelControls = function () {
    if (!currentDataset) return;

    // Update label selector in annotate view
    const labelSelect = document.getElementById('labelSelect');
    if (labelSelect) {
        labelSelect.innerHTML = '<option value="">Select label...</option>' +
            currentDataset.labels.map(label => `<option value="${label}">${label}</option>`).join('');
    }

    // Re-bind change listener if needed (already handled by app.js or annotator.js)
    console.log('UI controls refreshed for labels:', currentDataset.labels);

    // If annotator has its own filter panel, it will be refreshed if linked to this window function
    // annotator.js defines its own window.buildFilterPanel which is called by its internal refreshLabelControls
};

// Batch Edit Labels Logic
const batchEditModal = document.getElementById('batchEditModal');
const batchEditTableBody = document.getElementById('batchEditTableBody');
const batchEditProgress = document.getElementById('batchEditProgress');
const applyBatchEditBtn = document.getElementById('applyBatchEditBtn');
const cancelBatchEditBtn = document.getElementById('cancelBatchEditBtn');
const closeBatchEditModalBtn = document.getElementById('closeBatchEditModalBtn');

function getColorForBatchLabel(label) {
    const palette = [
        { bg: '#f5f3ff', text: '#7c3aed' }, // Violet
        { bg: '#eff6ff', text: '#2563eb' }, // Blue
        { bg: '#ecfdf5', text: '#059669' }, // Emerald
        { bg: '#fff7ed', text: '#ea580c' }, // Orange
        { bg: '#fdf2f8', text: '#db2777' }, // Pink
        { bg: '#f0fdf4', text: '#16a34a' }, // Green
        { bg: '#fef2f2', text: '#dc2626' }, // Red
        { bg: '#fffbeb', text: '#d97706' }, // Amber
        { bg: '#f5f5f4', text: '#57534e' }  // Stone
    ];
    
    // Simple hash function for consistent color selection
    let hash = 0;
    for (let i = 0; i < label.length; i++) {
        hash = label.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
}

const openBatchEditModal = async () => {
    if (!currentDataset) return;
    
    // 1. Initial State
    batchEditTableBody.innerHTML = '<tr><td colspan="2" style="padding: 40px; text-align: center;"><div class="spinner-sm" style="margin: 0 auto 12px auto; width: 24px; height: 24px; border-width: 3px;"></div><div style="color: #64748b; font-size: 14px; font-weight: 500;">Scanning annotations for unique labels...</div></td></tr>';
    batchEditProgress.style.display = 'none';
    applyBatchEditBtn.disabled = true;
    batchEditModal.style.display = 'flex';

    try {
        // 2. Fetch unique labels directly from the annotation files via the API
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/labels`);
        if (!response.ok) throw new Error('Failed to fetch labels');
        const labels = await response.json();
        
        // 3. Clear and populate table
        batchEditTableBody.innerHTML = '';
        
        if (!labels || labels.length === 0) {
            batchEditTableBody.innerHTML = '<tr><td colspan="2" style="padding: 40px; text-align: center; color: #94a3b8; font-style: italic;">No labels found in this dataset\'s annotations.</td></tr>';
            return;
        }

        // Sort labels alphabetically for easier navigation
        const sortedLabels = [...labels].sort((a, b) => a.localeCompare(b));
        
        sortedLabels.forEach(label => {
            const tr = document.createElement('tr');
            tr.className = 'batch-edit-row';
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            const colors = getColorForBatchLabel(label);
            
            tr.innerHTML = `
                <td style="padding: 12px 24px; border-right: 1px solid rgba(255,255,255,0.1); width: 45%;">
                    <span class="label-badge" style="background: ${colors.bg}; color: ${colors.text};">
                        ${label}
                    </span>
                </td>
                <td style="padding: 12px 24px;">
                    <div style="display: flex; align-items: center;">
                        <span style="color: rgba(255,255,255,0.2); font-weight: 800; margin-right: 15px; font-size: 14px;">→</span>
                        <input type="text" class="batch-label-input" data-original="${label}" placeholder="New name..." 
                               style="flex: 1; padding: 10px 14px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; font-size: 13px; font-weight: 500; color: #f8fafc; background: rgba(255,255,255,0.03);">
                    </div>
                </td>
            `;
            batchEditTableBody.appendChild(tr);
        });
        
        applyBatchEditBtn.disabled = false;
        cancelBatchEditBtn.disabled = false;
    } catch (err) {
        console.error('Error opening batch edit:', err);
        batchEditTableBody.innerHTML = `<tr><td colspan="2" style="padding: 20px; text-align: center; color: #ef4444;">Error: ${err.message}</td></tr>`;
    }
};

const closeBatchEditModal = () => {
    batchEditModal.style.display = 'none';
};

if (document.getElementById('batchEditLabelsBtn')) {
    document.getElementById('batchEditLabelsBtn').addEventListener('click', openBatchEditModal);
}

if (closeBatchEditModalBtn) closeBatchEditModalBtn.addEventListener('click', closeBatchEditModal);
if (cancelBatchEditBtn) cancelBatchEditBtn.addEventListener('click', closeBatchEditModal);

applyBatchEditBtn.addEventListener('click', async () => {
    if (!currentDataset) return;
    
    const inputs = batchEditModal.querySelectorAll('.batch-label-input');
    const labelMap = {};
    let hasChanges = false;
    
    inputs.forEach(input => {
        const original = input.dataset.original;
        const target = input.value.trim();
        if (target && target !== original) {
            labelMap[original] = target;
            hasChanges = true;
        }
    });
    
    if (!hasChanges) {
        alert('Please specify at least one label change.');
        return;
    }
    
    if (!confirm('Are you sure you want to apply these label changes across the entire dataset? This cannot be undone automatically.')) {
        return;
    }
    
    // Disable UI
    applyBatchEditBtn.disabled = true;
    cancelBatchEditBtn.disabled = true;
    batchEditProgress.style.display = 'block';
    batchEditProgress.textContent = 'Preparing...';
    
    try {
        const response = await fetch(`${API_BASE}/datasets/${currentDataset.id}/batch-edit-labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelMap })
        });
        
        if (!response.ok) {
            throw new Error(await response.text());
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (!line.trim() || !line.startsWith('data: ')) continue;
                
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data.progress !== undefined) {
                        batchEditProgress.textContent = `Processing: ${data.progress}%`;
                    }
                    
                    if (data.success) {
                        alert(`Successfully updated labels!\n- Files modified: ${data.processedFiles}\n- Labels changed: ${data.processedLabels}`);
                        closeBatchEditModal();
                        
                        // Clear active annotation cache to force reload of labels from disk
                        if (window.clearAnnotationCache) window.clearAnnotationCache();
                        
                        // Re-fetch dataset to get new label schema if it changed
                        await openDataset(currentDataset.id);
                        
                        // If annotator is active, refresh the current image
                        if (typeof window.refreshCurrentImageData === 'function') {
                            window.refreshCurrentImageData();
                        }
                    } else if (data.error) {
                        alert('Error: ' + data.error);
                        applyBatchEditBtn.disabled = false;
                        cancelBatchEditBtn.disabled = false;
                    }
                } catch (e) {
                    console.error('Error parsing SSE:', e);
                }
            }
        }
    } catch (err) {
        console.error('Batch edit failed:', err);
        alert('Failure: ' + err.message);
        applyBatchEditBtn.disabled = false;
        cancelBatchEditBtn.disabled = false;
    }
});
