// Canvas and Annotation State
console.log('annotator.js initializing...');
let canvas = null;
let ctx = null;
let currentImage = null;
let currentImageId = null;
let annotations = [];
let lastUsedLabel = '';
let selectedAnnotation = null;
let currentTool = 'select';
let currentLabel = '';
let isDrawing = false;
let startPoint = null;
let tempPoints = [];
let isHoveringFirstPoint = false;

// Canvas transform
let scale = 1;
let fitScale = 0; // The scale at which the image fits the container
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let isPanningMiddle = false; // middle mouse button pan — separate from isDragging
let hasMoved = false;
let lastMoveTime = 0; // Tracks when the last drag/resize ended to block accidental dblclick
let lastBboxCreatedAt = 0; // Tracks when the last bbox was created to block double-fire
let dragStart = null;
let panRafId = null; // RAF handle for throttled panning renders
let isResizing = false;
let resizeHandle = null; // 'nw', 'ne', 'se', 'sw'
let isDraggingPoint = false;   // dragging a polygon keypoint
let draggingPointIndex = -1;   // which keypoint is being dragged

// Multi-selection & Rotation State
let selectedAnnotations = new Set();
let isSelectionBoxDrawing = false;
let selectionBoxStart = null;
let selectionBoxEnd = null;
let rotationBaseState = new Map(); // Store original state before rotation
let initialDragPositions = new Map(); // Store original positions before dragging multiple items
let manualSortSequence = []; // Store the order of annotations clicked during manual sort
let overlapPickerActive = false; // True when the overlap picker panel is visible

// Undo/Redo State
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;

function saveUndoState() {
    const snapshot = JSON.stringify(annotations);
    if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) return;
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = []; // Any new action clears the redo history
}

function undo() {
    if (undoStack.length === 0) return;
    // Save current state to redo stack before restoring
    redoStack.push(JSON.stringify(annotations));
    if (redoStack.length > MAX_UNDO) redoStack.shift();

    annotations = JSON.parse(undoStack.pop());
    selectedAnnotation = null;
    selectedAnnotations.clear();
    render();
    renderAnnotationsList();
    updateToolbarState();
    saveAnnotations();
}

function redo() {
    if (redoStack.length === 0) return;
    // Save current state to undo stack before re-applying
    undoStack.push(JSON.stringify(annotations));
    if (undoStack.length > MAX_UNDO) undoStack.shift();

    annotations = JSON.parse(redoStack.pop());
    selectedAnnotation = null;
    selectedAnnotations.clear();
    render();
    renderAnnotationsList();
    updateToolbarState();
    saveAnnotations();
}
let isAutoSave = false;
let showLabels = true;
let visibleLabels = null; // null = show all; Set = only show labels in the set
let renderRequestId = null;
let mousePos = { x: 0, y: 0 }; // current cursor in screen coords, used by render() for live previews
let _scheduleRafId = null;      // RAF handle for scheduleRender()
const hiddenAnnotations = new Set();

function updateShowAllBtn() {
    const btn = document.getElementById('showAllHiddenBtn');
    if (!btn) return;
    const hasHidden = hiddenAnnotations.size > 0;
    btn.style.color = hasHidden ? '#ef4444' : 'var(--text-secondary)';
    btn.style.borderColor = hasHidden ? '#ef4444' : 'var(--border-color)';
}

let isSaving = false;      // prevent concurrent saves
let pendingSavePayload = null; // queue the exact snapshot payload if a save is in-flight

// Prefetch variables
const prefetchCache = new Map(); // stores { image: HTMLImageElement, annPromise: Promise }
window.clearAnnotationCache = () => {
    prefetchCache.clear();
    console.log('[CACHE] Annotation prefetch cache cleared.');
};
const MAX_PREFETCH_DISTANCE = 10;

function triggerPrefetch(currentIndex) {
    if (!window.datasetImages) return;
    
    // Clear old cache entries that are too far away
    for (const [id, _] of prefetchCache.entries()) {
        const itemIdx = window.datasetImages.findIndex(img => img.id == id);
        if (itemIdx === -1 || Math.abs(itemIdx - currentIndex) > MAX_PREFETCH_DISTANCE * 2) {
            prefetchCache.delete(id); // Free memory
        }
    }

    // Prefetch next and prev (and ensure current is cached too)
    const indicesToFetch = [currentIndex];
    for (let i = 1; i <= MAX_PREFETCH_DISTANCE; i++) {
        if (currentIndex + i < window.datasetImages.length) indicesToFetch.push(currentIndex + i);
        if (currentIndex - i >= 0) indicesToFetch.push(currentIndex - i);
    }

    for (const idx of indicesToFetch) {
        const imgData = window.datasetImages[idx];
        if (!imgData) continue;
        
        if (!prefetchCache.has(imgData.id)) {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.src = imgData.path; // Starts background network fetch

            let annPromise = Promise.resolve([]);
            if (window.currentDataset) {
                annPromise = fetch(`${API_BASE}/datasets/${window.currentDataset.id}/annotations/${imgData.id}`)
                    .then(res => res.ok ? res.json() : [])
                    .catch(() => []);
            }

            prefetchCache.set(imgData.id, {
                image: img,
                annPromise: annPromise
            });
        }
    }
}
let saveDebounceTimer = null;

// Debounced save — collapses rapid auto-saves into one (used while dragging)
function debouncedSave(delay = 300) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => saveAnnotations(), delay);
}

// Initialize canvas
function initCanvas() {
    canvas = document.getElementById('annotationCanvas');
    ctx = canvas.getContext('2d');

    const container = document.getElementById('canvasContainer');
    if (container) {
        // Automatically resize canvas when container changes (e.g., sidebar toggle)
        const resizeObserver = new ResizeObserver(() => {
            if (canvas && container) {
                // Throttle resize events to animation frames
                if (renderRequestId) return;
                renderRequestId = requestAnimationFrame(() => {
                    canvas.width = container.clientWidth;
                    canvas.height = container.clientHeight;
                    fitScale = calculateFitScale();
                    clampOffsets();
                    render();
                    updateScrollbar();
                    renderRequestId = null;
                });
            }
        });
        resizeObserver.observe(container);
    }

    // Tool selection
    // Tool selection
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tool === currentTool && currentTool === 'manual_sort') {
                // Toggle off manual sort if clicked again - directly switch to select
                const selectBtn = document.querySelector('[data-tool="select"]');
                if (selectBtn) {
                    currentTool = 'select'; // Force state change before next line
                    selectBtn.click();
                }
                return;
            }

            document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
            canvas.style.cursor = (currentTool === 'select' || currentTool === 'bbox2poly' || currentTool === 'poly2bbox' || currentTool === 'rotate' || currentTool === 'manual_sort') ? 'default' : 'crosshair';

            resetManipulationSliders();
            manualSortSequence = []; // Reset sequence on tool change

            // Clear selection when entering manual sort
            if (currentTool === 'manual_sort') {
                selectAnnotation(null);
            }

            updateToolbarState();

            // When switching to bbox2poly and a bbox is selected, convert it right away
            if (currentTool === 'bbox2poly' && selectedAnnotation && selectedAnnotation.type === 'bbox') {
                convertBboxToPoly(selectedAnnotation);
                render();
            }
            if (currentTool === 'poly2bbox' && selectedAnnotation && (selectedAnnotation.type === 'polygon' || selectedAnnotation.type === 'poly')) {
                convertPolyToBbox(selectedAnnotation);
                render();
                renderAnnotationsList();
                debouncedSave();
            }

            render(); // Ensure canvas updates (e.g. clear sequence numbers)
        });
    });



    // Populate Label Filter
    window.refreshLabelControls = function () {
        const labelSelect = document.getElementById('labelSelect');
        if (!labelSelect || !window.currentDataset) return;

        // Remember current selection
        const previousSelection = labelSelect.value;

        // Clear and repopulate dropdown
        labelSelect.innerHTML = '<option value="">Select label...</option>';
        if (window.currentDataset.labels) {
            window.currentDataset.labels.forEach(lbl => {
                const opt = document.createElement('option');
                opt.value = lbl;
                opt.textContent = lbl;
                labelSelect.appendChild(opt);
            });
        }

        // Restore selection if it still exists
        if (previousSelection && Array.from(labelSelect.options).some(o => o.value === previousSelection)) {
            labelSelect.value = previousSelection;
        }

        // Refresh sidebar filter panel if it's initialized
        if (typeof window.buildFilterPanel === 'function') {
            window.buildFilterPanel();
        }
    };

    // Initial population
    window.refreshLabelControls();

    // Label selection (Filter)
    if (labelSelect) {
        labelSelect.addEventListener('change', (e) => {
            currentLabel = e.target.value;
            render();
            renderAnnotationsList();
        });
    }

    // Canvas events
    canvas.addEventListener('pointerdown', handleMouseDown);
    canvas.addEventListener('pointermove', handleMouseMove);
    canvas.addEventListener('pointerup', handleMouseUp);
    canvas.addEventListener('pointercancel', handleMouseUp); // Handle interrupted pointers
    canvas.addEventListener('mouseleave', () => { if (!isPanningMiddle) isDrawing = false; });

    // Middle-click pan — use document-level events to avoid losing mouseup when pointer leaves canvas
    document.addEventListener('mousemove', e => {
        if (!isPanningMiddle || !dragStart) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        offsetX += x - dragStart.x;
        offsetY += y - dragStart.y;
        dragStart = { x, y };
        clampOffsets();
        render();
        updateScrollbar();
    });

    document.addEventListener('mouseup', e => {
        if (e.button !== 1 || !isPanningMiddle) return;
        isPanningMiddle = false;
        dragStart = null;
        canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
        document.body.style.cursor = '';
    });

    canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('contextmenu', e => { if (e.button === 1) e.preventDefault(); });

    // Double click to edit label
    canvas.addEventListener('dblclick', handleDoubleClick);

    // Initial render
    render();
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    // Auto Save
    initAutoSave();

    // Zoom controls
    document.getElementById('zoomInBtn').addEventListener('click', () => zoomCanvas(1.2));
    document.getElementById('zoomOutBtn').addEventListener('click', () => zoomCanvas(0.8));
    document.getElementById('fitBtn').addEventListener('click', fitToScreen);

    // Save annotations
    document.getElementById('saveAnnotationsBtn').addEventListener('click', saveAnnotations);

    // Toggle Labels
    const toggleLabelsBtn = document.getElementById('toggleLabelsBtn');
    if (toggleLabelsBtn) {
        toggleLabelsBtn.addEventListener('click', () => {
            showLabels = !showLabels;
            if (showLabels) toggleLabelsBtn.classList.add('active');
            else toggleLabelsBtn.classList.remove('active');
            render();
        });
    }

    // Show all hidden annotations
    const showAllHiddenBtn = document.getElementById('showAllHiddenBtn');
    if (showAllHiddenBtn) {
        showAllHiddenBtn.addEventListener('click', () => {
            hiddenAnnotations.clear();
            updateShowAllBtn();
            scheduleRender();
            renderAnnotationsList();
        });
    }

    // Filter labels shown in the sidebar list
    (function initFilterLabels() {
        const btn = document.getElementById('filterLabelsBtn');
        const panel = document.getElementById('filterLabelsPanel');
        const checkboxesContainer = document.getElementById('filterLabelsCheckboxes');
        const badge = document.getElementById('filterLabelsBadge');
        const toggleAllBtn = document.getElementById('filterLabelsClearBtn');
        if (!btn || !panel) return;

        // null = show all; Set = show only those labels
        function updateBadge() {
            const isFiltered = visibleLabels !== null;
            badge.style.display = isFiltered ? 'block' : 'none';
            if (isFiltered) badge.textContent = visibleLabels.size;
            btn.classList.toggle('active', isFiltered);
        }

        function updateToggleBtn() {
            // If all checkboxes checked (or no filter) → offer to deselect all; else → offer select all
            const allChecked = visibleLabels === null;
            toggleAllBtn.textContent = allChecked ? 'Bỏ chọn tất cả' : 'Chọn tất cả';
        }

        // Expose to window so refreshLabelControls can call it
        window.buildFilterPanel = function () {
            const labelSelect = document.getElementById('labelSelect');
            if (!labelSelect) return;
            checkboxesContainer.innerHTML = '';
            Array.from(labelSelect.options).forEach(opt => {
                if (!opt.value) return;
                const label = opt.value;
                const color = getLabelColor(label);
                const checked = visibleLabels === null || visibleLabels.has(label);
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px;cursor:pointer;font-size:0.82rem;user-select:none;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = checked;
                cb.style.cursor = 'pointer';
                const txt = document.createElement('span');
                txt.textContent = label;
                txt.style.color = 'var(--text-primary)';
                row.append(cb, txt);
                row.addEventListener('click', (e) => {
                    if (e.target !== cb) cb.checked = !cb.checked; // clicking row toggles
                    if (cb.checked) {
                        if (visibleLabels === null) return; // already show all, nothing to do
                        visibleLabels.add(label);
                    } else {
                        if (visibleLabels === null) {
                            // First exclusion: populate set with everything except this label
                            const lbls = Array.from(labelSelect.options).filter(o => o.value && o.value !== label).map(o => o.value);
                            visibleLabels = new Set(lbls);
                        } else {
                            visibleLabels.delete(label);
                        }
                    }
                    updateBadge();
                    updateToggleBtn();
                    scheduleRender();
                    renderAnnotationsList();
                });
                checkboxesContainer.appendChild(row);
            });
            updateToggleBtn();
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = panel.style.display !== 'none';
            if (!isOpen) window.buildFilterPanel();
            panel.style.display = isOpen ? 'none' : 'block';
        });

        toggleAllBtn.addEventListener('click', () => {
            if (visibleLabels === null) {
                // Currently showing all → deselect all (hide all)
                visibleLabels = new Set();
            } else {
                // Currently filtered → select all (show all)
                visibleLabels = null;
            }
            buildFilterPanel();
            updateBadge();
            scheduleRender();
            renderAnnotationsList();
        });

        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== btn) {
                panel.style.display = 'none';
            }
        });
    })();

    // Delete annotation
    document.getElementById('deleteAnnotationBtn').addEventListener('click', deleteSelectedAnnotation);

    // Merge annotations
    const mergeBtn = document.getElementById('mergeAnnotationsBtn');
    if (mergeBtn) {
        mergeBtn.addEventListener('click', mergeSelectedAnnotations);
    }

    // Undo
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', undo);
    }

    // Navigation
    document.getElementById('prevImageBtn').addEventListener('click', () => navigateImage(-1));
    document.getElementById('nextImageBtn').addEventListener('click', () => navigateImage(1));

    // Layout Sorting
    const sortLayoutsBtn = document.getElementById('sortLayoutsBtn');
    if (sortLayoutsBtn) {
        sortLayoutsBtn.addEventListener('click', sortLayouts);
    }

    // Initialize Drag and Drop for Annotations List
    const list = document.getElementById('annotationsList');
    list.addEventListener('dragover', e => {
        // Capture state once when dragging starts in the list
        if (!document.querySelector('.annotation-item.dragging').dataset.undoSaved) {
            saveUndoState();
            document.querySelector('.annotation-item.dragging').dataset.undoSaved = 'true';
        }
        e.preventDefault();
        const afterElement = getDragAfterElement(list, e.clientY);
        const draggable = document.querySelector('.annotation-item.dragging');
        if (afterElement == null) {
            list.appendChild(draggable);
        } else {
            list.insertBefore(draggable, afterElement);
        }

        // Live update of reading order on canvas
        updateReadingOrderVisuals();
    });

    // We use dragend to sync state because drop might not fire if dropped outside container
    // but the DOM was already modified by dragover.
    // list.addEventListener('drop', e => { ... }); // Removed drop listener reference

    // Extract All
    const extractAllBtn = document.getElementById('extractAllBtn');
    if (extractAllBtn) {
        extractAllBtn.addEventListener('click', extractAllAnnotations);
    }

    // Panel Toggles
    const toggleLeftPanelBtn = document.getElementById('toggleLeftPanelBtn');
    if (toggleLeftPanelBtn) {
        toggleLeftPanelBtn.addEventListener('click', () => {
            const container = document.querySelector('.annotate-container');
            const isCollapsing = !container.classList.contains('left-panel-collapsed');
            container.classList.toggle('left-panel-collapsed');

            // If we are expanding, scroll to the active image
            if (isCollapsing) { // Wait, isCollapsing was true BEFORE toggle, so it's expanding now if toggle makes it false? 
                // Ah, if BEFORE toggle it didn't have the class, it WAS expanded. 
                // Let's re-think:
            }

            const isNowCollapsed = container.classList.contains('left-panel-collapsed');
            if (!isNowCollapsed) {
                // Expanded - Scroll to active image after a short delay for animation
                setTimeout(() => {
                    const activeImg = document.querySelector('.image-item.active');
                    if (activeImg) {
                        activeImg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                }, 300);
            }
        });
    }

    const toggleRightPanelBtn = document.getElementById('toggleRightPanelBtn');
    if (toggleRightPanelBtn) {
        toggleRightPanelBtn.addEventListener('click', () => {
            document.querySelector('.annotate-container').classList.toggle('right-panel-collapsed');
            // Canvas will auto-resize via ResizeObserver
        });
    }

    // Manipulation Control Listeners (Rotate & Scale)
    const rotationSlider = document.getElementById('rotationSlider');
    const rotationValue = document.getElementById('rotationValue');
    const scaleSlider = document.getElementById('scaleSlider');
    const scaleValueDisp = document.getElementById('scaleValue');
    const resetRotationBtn = document.getElementById('resetRotationBtn');

    if (rotationSlider && scaleSlider) {
        const handleManipulationInput = () => {
            const angle = parseFloat(rotationSlider.value);
            const scaleVal = parseFloat(scaleSlider.value);

            rotationValue.textContent = `${angle.toFixed(1)}°`;
            scaleValueDisp.textContent = `${scaleVal.toFixed(2)}x`;

            applyManipulation(angle, scaleVal);
        };

        rotationSlider.addEventListener('input', handleManipulationInput);
        scaleSlider.addEventListener('input', handleManipulationInput);

        // Initialize manipulation baseline when starting drag on either slider
        const captureBaseline = () => {
            saveUndoState();
            captureRotationBaseline();
            resetManipulationSliders(); // Ensure sliders are 0 relative to captured baseline
        };
        rotationSlider.addEventListener('mousedown', captureBaseline);
        scaleSlider.addEventListener('mousedown', captureBaseline);

        const handleManipulationChange = () => {
            saveAnnotations();
            renderAnnotationsList();
        };
        rotationSlider.addEventListener('change', handleManipulationChange);
        scaleSlider.addEventListener('change', handleManipulationChange);
    }

    if (resetRotationBtn) {
        resetRotationBtn.addEventListener('click', () => {
            if (rotationSlider) rotationSlider.value = 0;
            if (scaleSlider) scaleSlider.value = 1.0;
            if (rotationValue) rotationValue.textContent = `0.0°`;
            if (scaleValueDisp) scaleValueDisp.textContent = `1.00x`;

            applyManipulation(0, 1.0);
            saveAnnotations();
            renderAnnotationsList();
        });
    }

    // Init Scrollbar
    setupScrollbar();
}

function captureRotationBaseline() {
    rotationBaseState.clear();
    selectedAnnotations.forEach(ann => {
        // Clone original state
        if (ann.type === 'bbox') {
            rotationBaseState.set(ann, {
                type: 'bbox',
                x: ann.x,
                y: ann.y,
                width: ann.width,
                height: ann.height
            });
        } else if (ann.type === 'polygon') {
            rotationBaseState.set(ann, {
                type: 'polygon',
                points: ann.points.map(p => ({ ...p }))
            });
        }
    });
}

function applyManipulation(angleDegrees, scaleFactor) {
    const angleRad = (angleDegrees * Math.PI) / 180;

    selectedAnnotations.forEach(ann => {
        const base = rotationBaseState.get(ann);
        if (!base) return;

        let points = [];
        let cx, cy;

        if (base.type === 'bbox') {
            // Convert bbox center
            cx = base.x + base.width / 2;
            cy = base.y + base.height / 2;
            // Define 4 corners
            points = [
                { x: base.x, y: base.y },
                { x: base.x + base.width, y: base.y },
                { x: base.x + base.width, y: base.y + base.height },
                { x: base.x, y: base.y + base.height }
            ];
            // Force convert to polygon for manipulation
            ann.type = 'polygon';
            delete ann.width;
            delete ann.height;
        } else {
            // Polygon center (centroid)
            cx = base.points.reduce((sum, p) => sum + p.x, 0) / base.points.length;
            cy = base.points.reduce((sum, p) => sum + p.y, 0) / base.points.length;
            points = base.points.map(p => ({ ...p }));
        }

        // Apply Width-Only Scaling and Rotation around center
        // 1. Determine Local X Axis (from P0 to P1 in baseline)
        let p0 = points[0];
        let p1 = points[1];
        let ux = p1.x - p0.x;
        let uy = p1.y - p0.y;
        let len = Math.sqrt(ux * ux + uy * uy);
        if (len < 0.1) { ux = 1; uy = 0; }
        else { ux /= len; uy /= len; }

        // 2. Local Y Axis (perpendicular to X)
        let vx = -uy;
        let vy = ux;

        ann.points = points.map(p => {
            // Transform to local coordinates relative to center
            let dx = p.x - cx;
            let dy = p.y - cy;

            let localU = dx * ux + dy * uy;
            let localV = dx * vx + dy * vy;

            // Apply Height Scaling only (preserving width)
            localV *= scaleFactor;

            // Reconstruct and Apply Rotation
            const rx = localU * ux + localV * vx;
            const ry = localU * uy + localV * vy;

            return {
                x: cx + rx * Math.cos(angleRad) - ry * Math.sin(angleRad),
                y: cy + rx * Math.sin(angleRad) + ry * Math.cos(angleRad)
            };
        });

        // Update bbox bounds for list items and selection highlights
        const xs = ann.points.map(p => p.x);
        const ys = ann.points.map(p => p.y);
        ann.x = Math.min(...xs);
        ann.y = Math.min(...ys);
        ann.width = Math.max(...xs) - ann.x;
        ann.height = Math.max(...ys) - ann.y;
    });

    render();
}

// Scrollbar Logic
let isProgrammaticScroll = false;

function setupScrollbar() {
    const sb = document.getElementById('verticalScrollbar');
    if (!sb) return;

    sb.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }

        // Map scrollTop to offsetY
        // offsetY determines the vertical shift of the image content.
        // scrollTop represents how much content is scrolled out of view at the top.
        // If scrollTop > 0, we want to shift image UP (offsetY negative).
        offsetY = -sb.scrollTop;
        render();
    });

    // Update on resize
    window.addEventListener('resize', () => {
        // Debounce?
        updateScrollbar();
        // Also fitToScreen behavior? Existing app might not handle it.
        // We just update scrollbar.
    });
}

function updateScrollbar() {
    const sb = document.getElementById('verticalScrollbar');
    const content = document.getElementById('verticalScrollbarContent');
    const container = document.getElementById('canvasContainer');

    if (!sb || !currentImage) {
        if (sb) sb.style.display = 'none';
        return;
    }

    const imgH = currentImage.height * scale;
    const containerH = container.clientHeight;

    if (imgH > containerH) {
        sb.style.display = 'block';
        content.style.height = `${imgH}px`;

        // Sync scrollTop from offsetY
        // offsetY = -scrollTop => scrollTop = -offsetY
        let targetScroll = -offsetY;

        // Clamp
        if (targetScroll < 0) targetScroll = 0;
        const maxScroll = sb.scrollHeight - sb.clientHeight;
        if (targetScroll > maxScroll) targetScroll = maxScroll;

        if (Math.abs(sb.scrollTop - targetScroll) > 1) {
            isProgrammaticScroll = true;
            sb.scrollTop = targetScroll;
        }
    } else {
        sb.style.display = 'none';
    }
}





async function extractAllAnnotations() {
    const btn = document.getElementById('extractAllBtn');
    const modelSelect = document.getElementById('toolbarModelSelect');
    const model = modelSelect.value;
    const originalContent = btn.innerHTML;

    // Filter annotations
    const ignoredLabels = ['image', 'logo', 'list', 'signature'];
    const targets = annotations.filter(a => !ignoredLabels.includes((a.label || '').toLowerCase()));

    if (targets.length === 0) {
        alert('No annotations to extract (or all already have content).');
        return;
    }

    if (!confirm(`Extract text for ${targets.length} annotations using ${model}?`)) return;

    btn.disabled = true;
    let completed = 0;
    const total = targets.length;
    const concurrencyLimit = 3;

    const processItem = async (ann) => {
        try {
            const imageData = cropImageFromCanvas(ann);
            if (!imageData) return;

            const response = await fetch('/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: imageData,
                    label: ann.label,
                    model: model
                })
            });

            if (response.ok) {
                const data = await response.json();
                ann.content = data.content;
            } else {
                console.error('Failed to extract for', ann.id);
            }
        } catch (e) {
            console.error('Error extracting', ann.id, e);
        } finally {
            completed++;
            btn.innerHTML = `${completed}/${total}`;
        }
    };

    // Simple parallelism
    const chunks = [];
    for (let i = 0; i < targets.length; i += concurrencyLimit) {
        chunks.push(targets.slice(i, i + concurrencyLimit));
    }

    for (const chunk of chunks) {
        await Promise.all(chunk.map(processItem));
        renderAnnotationsList(); // Update UI periodically
    }

    saveAnnotations();
    btn.disabled = false;
    btn.innerHTML = originalContent;
    alert(`Extraction completed for ${total} items.`);
}

function navigateImage(direction) {
    const activeItem = document.querySelector('.image-item.active');
    if (!activeItem) return;

    let targetItem = direction === -1
        ? activeItem.previousElementSibling
        : activeItem.nextElementSibling;

    // Filtered mode: Skip until we find a problematic image
    if (window.duplicateModeActive && window.duplicateImageIds) {
        while (targetItem && !window.duplicateImageIds.has(String(targetItem.dataset.id))) {
            targetItem = direction === -1
                ? targetItem.previousElementSibling
                : targetItem.nextElementSibling;
        }
    }

    if (targetItem) {
        targetItem.click();
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Forward image path and ID for immediate loading
        if (targetItem.dataset.path && targetItem.dataset.id) {
            loadImageInCanvas(targetItem.dataset.path, targetItem.dataset.id, true);
        }
    }
}

/**
 * Sorts all annotations top-to-bottom, left-to-right.
 * Updates the 'reading_order' property and persists changes.
 */
function sortLayouts() {
    saveUndoState();
    if (annotations.length === 0) return;

    // Helper to get consistent (x, y) for sorting
    const getBounds = (ann) => {
        if (ann.type === 'bbox') return { x: ann.x, y: ann.y };
        if (ann.type === 'polygon' && ann.points) {
            const xs = ann.points.map(p => p.x);
            const ys = ann.points.map(p => p.y);
            return { x: Math.min(...xs), y: Math.min(...ys) };
        }
        return { x: 0, y: 0 };
    };

    // Sort clones to determine new order
    const sorted = [...annotations].sort((a, b) => {
        const bA = getBounds(a);
        const bB = getBounds(b);

        // Sorting: primarily Y (top-to-bottom), then X (left-to-right)
        // Using a 12px tolerance for "same line" alignment
        const yDiff = bA.y - bB.y;
        if (Math.abs(yDiff) < 12) {
            return bA.x - bB.x;
        }
        return yDiff;
    });

    // Reorder the original array to match sorted order
    // This ensures the DOM list order matches the reading_order
    annotations = sorted;

    // Update reading_order property to match new array order
    annotations.forEach((ann, idx) => {
        ann.reading_order = idx;
    });

    renderAnnotationsList();
    render();
    saveAnnotations();

    // Pulse indicator or similar? For now alert is fine if user expects it.
    // console.log('Sorted layouts by position.');
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.annotation-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Helper to update canvas visuals during drag
function updateReadingOrderVisuals() {
    const list = document.getElementById('annotationsList');
    list.querySelectorAll('.annotation-item').forEach((domItem, newIndex) => {
        const originalIndex = parseInt(domItem.dataset.index);
        const ann = annotations[originalIndex];
        if (ann) {
            ann.reading_order = newIndex;
        }
    });
    render();
}

function initAutoSave() {
    const btn = document.getElementById('autoSaveBtn');
    const indicator = document.getElementById('autoSaveIndicator');

    // Load from local storage
    isAutoSave = localStorage.getItem('autoSaveEnabled') === 'true';

    // Update UI
    if (isAutoSave) {
        indicator.style.display = 'block';
        btn.classList.add('active');
    }

    btn.addEventListener('click', () => {
        isAutoSave = !isAutoSave;
        localStorage.setItem('autoSaveEnabled', isAutoSave);

        if (isAutoSave) {
            indicator.style.display = 'block';
            btn.classList.add('active');
            saveAnnotations(); // Save immediately when enabled
        } else {
            indicator.style.display = 'none';
            btn.classList.remove('active');
        }
    });
}


let loadingImage = null;
let loadDebounceTimer = null;

// Debounced wrapper
function loadImageInCanvas(imagePath, imageId, immediate = false) {
    if (loadDebounceTimer) {
        clearTimeout(loadDebounceTimer);
        loadDebounceTimer = null;
    }

    if (immediate) {
        performLoadImage(imagePath, imageId);
    } else {
        loadDebounceTimer = setTimeout(() => {
            performLoadImage(imagePath, imageId);
        }, 50); // Reduced from 150ms for snappier feel
    }
}

// Actual load logic (Concurrent + Prefetch)
async function performLoadImage(imagePath, imageId) {
    currentImageId = imageId;
    undoStack = []; // Clear undo history on image load
    redoStack = [];
    selectedAnnotations.clear();
    hiddenAnnotations.clear();
    selectedAnnotation = null;

    const fileName = imagePath ? imagePath.split('/').pop() : imageId;
    document.getElementById('canvasStatus').textContent = `Loading: ${fileName}`;

    const delBtn = document.getElementById('deleteAnnotationBtn');
    if (delBtn) delBtn.disabled = true;

    // Save to localStorage for Resume feature and trigger prefetch
    let currentIndex = -1;
    if (window.currentDataset && window.datasetImages) {
        currentIndex = window.datasetImages.findIndex(img => img.id == imageId);
        if (currentIndex !== -1) {
            localStorage.setItem(`lastImageIndex_${window.currentDataset.id}`, currentIndex);
            
            // Defuse network starvation: Wait 250ms before launching the 40+ background requests.
            // This guarantees the browser's 6-connection multiplex limit immediately prioritizes
            // the FOREGROUND image request that we are about to dispatch below.
            setTimeout(() => triggerPrefetch(currentIndex), 250);
        }
    }

    const cached = prefetchCache.get(imageId);

    // 1. Annotations Promise
    let annPromise = Promise.resolve([]);
    if (cached && cached.annPromise) {
        annPromise = cached.annPromise;
    } else if (window.currentDataset) {
        annPromise = fetch(`${API_BASE}/datasets/${window.currentDataset.id}/annotations/${imageId}?t=${Date.now()}`)
            .then(res => res.ok ? res.json() : [])
            .catch(err => {
                console.error('Error loading annotations:', err);
                return [];
            });
    }

    // Determine if we should blink the canvas to provide loading feedback
    // If the image is fully cached in RAM, it's instant.
    const isInstant = cached && cached.image && cached.image.complete && cached.image.naturalWidth > 0;
    if (!isInstant) {
        currentImage = null;
        annotations = [];
        render(); // Immediately wipe canvas to signal "Loading..."
    }

    // Cancel previous image load if any
    if (loadingImage && (!cached || loadingImage !== cached.image)) {
        loadingImage.onload = null;
        loadingImage.src = '';
        loadingImage = null;
    }

    // 2. Image Promise
    const imgPromise = new Promise((resolve) => {
        if (isInstant) {
            resolve(cached.image);
        } else {
            const img = new Image();
            loadingImage = img;
            img.crossOrigin = "Anonymous"; // Fix for potential CORS issues
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = imagePath; // Browser correctly multiplexes with background prefetch request
        }
    });

    // 3. Parallel Wait Barrier
    const [img, loadedAnnotations] = await Promise.all([imgPromise, annPromise]);

    // Race condition check: Only proceed if this is still the requested image
    if (currentImageId !== imageId) return;

    // --- Process Image ---
    if (img) {
        loadingImage = null;
        currentImage = img;

        // Lazy update dimensions in DB if they were 0 during import
        if (window.datasetImages) {
            const imgData = window.datasetImages.find(i => i.id == imageId);
            if (imgData && (imgData.width === 0 || imgData.height === 0)) {
                imgData.width = img.width;
                imgData.height = img.height;

                // Safe fallback to plain ID for patch update
                fetch(`/api/images/${imageId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ width: img.width, height: img.height })
                }).catch(err => console.error('Error auto-updating dimensions:', err));
            }
        }
    } else {
        currentImage = null;
    }

    // --- Process Annotations ---
    annotations = loadedAnnotations || [];
    annotations.sort((a, b) => {
        const roA = (a.reading_order !== undefined && a.reading_order !== null) ? a.reading_order : 999999;
        const roB = (b.reading_order !== undefined && b.reading_order !== null) ? b.reading_order : 999999;
        return roA - roB;
    });

    if (typeof updateShowAllBtn === 'function') updateShowAllBtn();
    renderAnnotationsList();

    // --- Final Render ---
    if (currentImage) {
        const container = document.getElementById('canvasContainer');
        if (container) {
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
        }
        fitToScreen(); // Implicitly calls render() and other view updates
    } else {
        render(); // Fallback if image fails but annotations load
    }

    document.getElementById('canvasStatus').textContent = `Loaded: ${fileName}`;
}

function calculateFitScale() {
    if (!currentImage) return 1;
    const container = document.getElementById('canvasContainer');
    if (!container) return 1;
    const scaleX = (container.clientWidth - 40) / currentImage.width;
    const scaleY = (container.clientHeight - 40) / currentImage.height;
    return Math.min(scaleX, scaleY, 1);
}

function fitToScreen() {
    if (!currentImage) return;

    fitScale = calculateFitScale();
    scale = fitScale;

    offsetX = (canvas.width - currentImage.width * scale) / 2;
    offsetY = (canvas.height - currentImage.height * scale) / 2;

    clampOffsets();
    render();
    updateZoomLevel();
    updateScrollbar();
}

function zoomCanvas(factor) {
    if (!currentImage) return;

    const oldScale = scale;
    scale *= factor;
    scale = Math.max(0.1, Math.min(scale, 5));

    // Zoom towards center
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    offsetX = centerX - (centerX - offsetX) * (scale / oldScale);
    offsetY = centerY - (centerY - offsetY) * (scale / oldScale);

    clampOffsets();
    render();
    updateZoomLevel();
    updateScrollbar();
}

function updateZoomLevel() {
    const zoomText = document.getElementById('zoomLevel');
    if (zoomText) {
        zoomText.textContent = `${Math.round(scale * 100)}%`;
    }

    const el = document.getElementById('pageCounter');
    if (!el) return;
    if (window.datasetImages && window.datasetImages.length > 0 && currentImageId) {
        const idx = window.datasetImages.findIndex(img => String(img.id) === String(currentImageId));
        const current = idx >= 0 ? idx + 1 : '--';
        const total = window.datasetImages.length;
        el.textContent = `${current} / ${total}`;
    } else {
        el.textContent = '-- / --';
    }
}

/**
 * Clamps canvas offsets so the image never leaves the viewport when zoomed in.
 * If image is smaller than viewport, it centers it.
 */
function clampOffsets() {
    if (!currentImage || !canvas) return;

    const imgW = currentImage.width * scale;
    const imgH = currentImage.height * scale;

    // Horizontal clamping
    if (imgW <= canvas.width) {
        // Image is smaller than canvas, center it
        offsetX = (canvas.width - imgW) / 2;
    } else {
        // Image is larger than canvas, clamp to edges
        if (offsetX > 0) offsetX = 0;
        if (offsetX < canvas.width - imgW) offsetX = canvas.width - imgW;
    }

    // Vertical clamping
    if (imgH <= canvas.height) {
        // Image is smaller than canvas, center it
        offsetY = (canvas.height - imgH) / 2;
    } else {
        // Image is larger than canvas, clamp to edges
        if (offsetY > 0) offsetY = 0;
        if (offsetY < canvas.height - imgH) offsetY = canvas.height - imgH;
    }
}

// Mouse event handlers
function handleDoubleClick(e) {
    if (!currentImage) return;
    // Ignore dblclick if it fired immediately after a drag/resize (< 300ms)
    if (Date.now() - lastMoveTime < 300) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // Find annotation under cursor using unified hit detection
    const clickedAnn = findAnnotationAt(e.clientX - rect.left, e.clientY - rect.top);

    if (clickedAnn) {
        showLabelModal((newLabel, newRO) => {
            if (newLabel) {
                clickedAnn.label = newLabel;

                // Handle Reading Order Move
                if (newRO !== null && newRO !== clickedAnn.reading_order) {
                    const idx = annotations.indexOf(clickedAnn);
                    if (idx > -1) annotations.splice(idx, 1);

                    // Re-index remaining temporarily to ensure gaps are closed
                    // (Though splice closes gaps in array, reading_order property might be stale)
                    // Actually, we should just rely on array position for reading_order usually.
                    // But here we want to force explicit reading_order.

                    // Target insertion index
                    let insertIdx = newRO;
                    if (insertIdx < 0) insertIdx = 0;
                    if (insertIdx > annotations.length) insertIdx = annotations.length;

                    annotations.splice(insertIdx, 0, clickedAnn);

                    // Update all reading_orders to match new array order
                    annotations.forEach((a, i) => a.reading_order = i);
                } else {
                    // Update reading_order for clickedAnn if it was null?
                    if (clickedAnn.reading_order === undefined || clickedAnn.reading_order === null) {
                        clickedAnn.reading_order = annotations.indexOf(clickedAnn);
                    }
                }

                render();
                renderAnnotationsList();
                saveAnnotations();
            }
        }, clickedAnn.label, clickedAnn.reading_order);
    }
}


function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pt = screenToImage(x, y);

    // Ignore right-click for everything except polygon tool
    // (Polygon tool uses right-click/double-click to finish)
    if (e.button === 2 && currentTool !== 'polygon') {
        return;
    }

    // Middle-click pan is fully handled by document-level mousedown/mousemove/mouseup
    if (e.button === 1) {
        isPanningMiddle = true;
        dragStart = { x, y };
        canvas.style.cursor = 'grabbing';
        document.body.style.cursor = 'grabbing';
        return;
    }


    // Manual Sort Guard: If items are selected, only allow clicks on those items.
    // Place this BEFORE saveUndoState to avoid junk in history.
    if (currentTool === 'manual_sort' && selectedAnnotations.size > 0) {
        const clicked = findAnnotationAt(x, y);
        if (!clicked || !selectedAnnotations.has(clicked)) {
            return;
        }
    }

    // Save state before potential modification
    if (currentTool !== 'select' || findAnnotationAt(x, y)) {
        saveUndoState();
    }

    if (currentTool === 'select' || currentTool === 'bbox2poly' || currentTool === 'poly2bbox' || currentTool === 'rotate' || currentTool === 'manual_sort') {
        const clicked = findAnnotationAt(x, y);

        // Manual Sort sequence clicking
        if (currentTool === 'manual_sort' && selectedAnnotations.size > 0) {
            const candidates = findAllAnnotationsAt(x, y, selectedAnnotations)
                .filter(ann => !manualSortSequence.includes(ann));

            if (candidates.length > 1) {
                // Multiple overlapping boxes — show picker
                showOverlapPicker(candidates);
                return;
            } else if (candidates.length === 1) {
                assignSortSequence(candidates[0]);
                return;
            }
        }

        // Polygon keypoint hit (Prioritize over selection toggling in Rotate/Manual Sort)
        if (selectedAnnotation && selectedAnnotation.type === 'polygon' && selectedAnnotation.points) {
            const kpIdx = getPolygonKeypointAt(pt, selectedAnnotation);
            if (kpIdx !== -1) {
                isDraggingPoint = true;
                draggingPointIndex = kpIdx;
                hasMoved = false;
                return;
            }
        }

        // BBox resize handles (Prioritize over selection toggling in Rotate/Manual Sort)
        if ((currentTool === 'select' || currentTool === 'poly2bbox' || currentTool === 'rotate') && selectedAnnotation && selectedAnnotation.type === 'bbox') {
            const handle = getResizeHandle(pt, selectedAnnotation);
            if (handle) {
                isResizing = true;
                resizeHandle = handle;
                return;
            }
        }

        // Multi-select with Ctrl or Tool Selection Box (Rotate / Manual Sort)
        if (e.ctrlKey || currentTool === 'rotate' || currentTool === 'manual_sort') {
            if (clicked) {
                // In Rotate mode, if we click an ALREADY selected item without Ctrl, 
                // we want to DRAG the group, not toggle selection.
                if ((currentTool === 'rotate' || currentTool === 'manual_sort') && !e.ctrlKey && selectedAnnotations.has(clicked)) {
                    // Fall through to drag baseline capture below
                } else {
                    if (selectedAnnotations.has(clicked)) {
                        selectedAnnotations.delete(clicked);
                    } else {
                        selectedAnnotations.add(clicked);
                    }
                    selectedAnnotation = selectedAnnotations.size > 0 ? [...selectedAnnotations][0] : null;
                    render();
                    renderAnnotationsList();
                    updateToolbarState();
                    return;
                }
            } else if (!e.ctrlKey && (currentTool === 'rotate' || currentTool === 'manual_sort')) {
                isSelectionBoxDrawing = true;
                selectionBoxStart = pt;
                selectionBoxEnd = pt;
                manualSortSequence = []; // Clear sequence if starting new selection
                selectAnnotation(null); // Triggers slider reset
                render();
                return;
            }
        }



        if (clicked) {
            if (currentTool === 'bbox2poly' && clicked.type === 'bbox') {
                convertBboxToPoly(clicked);
                selectAnnotation(clicked);
                render();
                const kpIdx = getPolygonKeypointAt(pt, clicked);
                if (kpIdx !== -1) {
                    isDraggingPoint = true;
                    draggingPointIndex = kpIdx;
                    hasMoved = false;
                    return;
                }
            } else if (currentTool === 'poly2bbox' && (clicked.type === 'polygon' || clicked.type === 'poly')) {
                convertPolyToBbox(clicked);
                selectAnnotation(clicked);
                render();
                renderAnnotationsList();
                debouncedSave();
                return; // Conversion complete, handle as normal selection from here
            } else {
                // If clicked is NOT in the current selection, select it normally (clears others)
                // If it IS in the selection, keep the group for multi-drag
                if (!selectedAnnotations.has(clicked)) {
                    selectAnnotation(clicked);
                }
            }

            // Capture baselines for all selected annotations
            initialDragPositions.clear();
            selectedAnnotations.forEach(ann => {
                if (ann.type === 'bbox' || ann.type === 'keypoint') {
                    initialDragPositions.set(ann, { x: ann.x, y: ann.y });
                } else if (ann.type === 'polygon') {
                    initialDragPositions.set(ann, ann.points.map(p => ({ ...p })));
                }
            });

            isDragging = true;
            hasMoved = false;
            dragStart = { x, y };
        }
        else {
            if (currentTool !== 'rotate') {
                isDragging = true;
                dragStart = { x, y };
                canvas.style.cursor = 'grabbing';
                selectAnnotation(null);
            }
        }
    } else if (currentTool === 'bbox') {
        isDrawing = true;
        startPoint = screenToImage(x, y);
    } else if (currentTool === 'polygon') {
        const point = screenToImage(x, y);
        // Constrain point to image bounds
        point.x = Math.max(0, Math.min(point.x, currentImage.width));
        point.y = Math.max(0, Math.min(point.y, currentImage.height));

        if (isHoveringFirstPoint) {
            finishPolygon();
            return;
        }
        if (e.button === 2 || e.detail === 2) {
            if (tempPoints.length >= 3) {
                finishPolygon();
            }
            return;
        }
        tempPoints.push(point);
        isDrawing = true;
        render();
    } else if (currentTool === 'keypoint') {
        const point = screenToImage(x, y);
        // Constrain point to image bounds
        point.x = Math.max(0, Math.min(point.x, currentImage.width));
        point.y = Math.max(0, Math.min(point.y, currentImage.height));
        addKeypointAnnotation(point);
    }
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Always track mouse position for live rendering previews
    mousePos = { x, y };

    // --- FAST PATH: middle-click pan (RAF-throttled, skip all other work) ---
    // Pan is handled by document.mousemove; skip all pointer processing during pan
    if (isPanningMiddle) return;

    const pt = screenToImage(x, y);

    // --- ACTIVE-STATE EARLY RETURNS: skip cursor/hover logic during manipulation ---

    if (isSelectionBoxDrawing) {
        selectionBoxEnd = pt;
        scheduleRender();
        return;
    }

    if (isDraggingPoint && selectedAnnotation && selectedAnnotation.type === 'polygon' && draggingPointIndex !== -1) {
        const p = selectedAnnotation.points[draggingPointIndex];
        p.x = Math.max(0, Math.min(pt.x, currentImage.width));
        p.y = Math.max(0, Math.min(pt.y, currentImage.height));
        hasMoved = true;
        // Keep bounding box in sync
        const xs = selectedAnnotation.points.map(q => q.x);
        const ys = selectedAnnotation.points.map(q => q.y);
        selectedAnnotation.x = Math.min(...xs);
        selectedAnnotation.y = Math.min(...ys);
        selectedAnnotation.width = Math.max(...xs) - selectedAnnotation.x;
        selectedAnnotation.height = Math.max(...ys) - selectedAnnotation.y;
        scheduleRender();
        return;
    }

    if (isResizing && selectedAnnotation && resizeHandle) {
        resizeAnnotation(selectedAnnotation, resizeHandle, pt);
        scheduleRender();
        return;
    }

    if (isDragging) {
        if (selectedAnnotation) {
            const dx = (x - dragStart.x) / scale;
            const dy = (y - dragStart.y) / scale;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) hasMoved = true;

            selectedAnnotations.forEach(ann => {
                if (ann.type === 'bbox' || ann.type === 'keypoint') {
                    let newX = ann.x + dx;
                    let newY = ann.y + dy;
                    if (ann.type === 'bbox') {
                        newX = Math.max(0, Math.min(newX, currentImage.width - ann.width));
                        newY = Math.max(0, Math.min(newY, currentImage.height - ann.height));
                    } else {
                        newX = Math.max(0, Math.min(newX, currentImage.width));
                        newY = Math.max(0, Math.min(newY, currentImage.height));
                    }
                    ann.x = newX;
                    ann.y = newY;
                } else if (ann.type === 'polygon') {
                    ann.points.forEach(p => {
                        p.x = Math.max(0, Math.min(p.x + dx, currentImage.width));
                        p.y = Math.max(0, Math.min(p.y + dy, currentImage.height));
                    });
                    // Sync bounding box
                    const xs = ann.points.map(q => q.x);
                    const ys = ann.points.map(q => q.y);
                    ann.x = Math.min(...xs); ann.y = Math.min(...ys);
                    ann.width = Math.max(...xs) - ann.x;
                    ann.height = Math.max(...ys) - ann.y;
                }
            });
            dragStart = { x, y };
        } else {
            // Canvas pan via left-button drag
            offsetX += x - dragStart.x;
            offsetY += y - dragStart.y;
            dragStart = { x, y };
            clampOffsets();
            updateScrollbar();
        }
        scheduleRender();
        return;
    }

    if (isDrawing && (currentTool === 'bbox' || currentTool === 'polygon')) {
        // Update hover state for polygon first-point snap
        if (currentTool === 'polygon' && tempPoints.length > 0) {
            const firstPointScreen = imageToScreen(tempPoints[0].x, tempPoints[0].y);
            const dist = Math.hypot(x - firstPointScreen.x, y - firstPointScreen.y);
            isHoveringFirstPoint = dist < 20;
            canvas.style.cursor = isHoveringFirstPoint ? 'pointer' : 'crosshair';
        }
        scheduleRender(); // render() will draw the live preview from mousePos
        return;
    }

    // --- IDLE PATH: update cursor / hover handles (only runs when not manipulating) ---
    if ((currentTool === 'select' || currentTool === 'bbox2poly' || currentTool === 'poly2bbox' || currentTool === 'rotate') && selectedAnnotation && !isDragging && !isResizing && !isDraggingPoint) {
        if (selectedAnnotation.type === 'polygon' && selectedAnnotation.points) {
            const kpIdx = getPolygonKeypointAt(pt, selectedAnnotation);
            canvas.style.cursor = kpIdx !== -1 ? 'crosshair' : 'default';
        } else if (selectedAnnotation.type === 'bbox') {
            const isPoly2Bbox = currentTool === 'poly2bbox';
            if (currentTool === 'bbox2poly') {
                const sPt = imageToScreen(pt.x, pt.y);
                const HIT = 10;
                const corners = [
                    imageToScreen(selectedAnnotation.x, selectedAnnotation.y),
                    imageToScreen(selectedAnnotation.x + selectedAnnotation.width, selectedAnnotation.y),
                    imageToScreen(selectedAnnotation.x + selectedAnnotation.width, selectedAnnotation.y + selectedAnnotation.height),
                    imageToScreen(selectedAnnotation.x, selectedAnnotation.y + selectedAnnotation.height)
                ];
                canvas.style.cursor = corners.some(c => distSq(sPt, c) < HIT * HIT) ? 'crosshair' : 'default';
            } else if (currentTool === 'select' || isPoly2Bbox || currentTool === 'rotate') {
                const handle = getResizeHandle(pt, selectedAnnotation);
                if (handle) {
                    canvas.style.cursor = (handle === 'nw' || handle === 'se') ? 'nwse-resize' : 'nesw-resize';
                } else {
                    canvas.style.cursor = 'default';
                }
            }
        } else {
            canvas.style.cursor = 'default';
        }
    }
}

function handleMouseUp(e) {
    if (isSelectionBoxDrawing) {
        // Finalize selection
        const xMin = Math.min(selectionBoxStart.x, selectionBoxEnd.x);
        const xMax = Math.max(selectionBoxStart.x, selectionBoxEnd.x);
        const yMin = Math.min(selectionBoxStart.y, selectionBoxEnd.y);
        const yMax = Math.max(selectionBoxStart.y, selectionBoxEnd.y);

        annotations.forEach(ann => {
            const cx = ann.x + ann.width / 2;
            const cy = ann.y + ann.height / 2;
            // Respect label filter if active
            if (currentLabel && ann.label !== currentLabel) return;
            // Respect sidebar multiselect filter
            if (visibleLabels !== null && !visibleLabels.has(ann.label)) return;
            // Respect hidden status
            if (hiddenAnnotations.has(ann)) return;

            if (cx >= xMin && cx <= xMax && cy >= yMin && cy <= yMax) {
                selectedAnnotations.add(ann);
            }
        });

        if (selectedAnnotations.size > 0) {
            selectedAnnotation = [...selectedAnnotations][0];
        }

        isSelectionBoxDrawing = false;
        selectionBoxStart = null;
        selectionBoxEnd = null;
        render();
        renderAnnotationsList();
        updateToolbarState();
        return;
    }

    // Middle button: pan is fully managed by document-level mouse listeners
    if (e.button === 1) return;


    if (isDraggingPoint) {
        isDraggingPoint = false;
        draggingPointIndex = -1;
        canvas.style.cursor = 'default';
        if (hasMoved) {
            lastMoveTime = Date.now(); // Guard against accidental dblclick
            renderAnnotationsList();
            debouncedSave(); // ensure disk sync after keypoint move
        }
        return;
    }
    if (isResizing) {
        isResizing = false;
        resizeHandle = null;
        lastMoveTime = Date.now(); // Guard against accidental dblclick
        renderAnnotationsList();
        debouncedSave(); // ensure disk sync after resize
    } else if (isDragging) {
        isDragging = false;
        canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
        if (selectedAnnotation) {
            if (hasMoved) {
                lastMoveTime = Date.now(); // Guard against accidental dblclick
                renderAnnotationsList();
                debouncedSave(); // ensure disk sync after drag
            }
        }
    } else if (isDrawing && currentTool === 'bbox' && startPoint) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const endPoint = screenToImage(x, y);

        // Calculate dimensions to check if valid box
        const width = Math.abs(endPoint.x - startPoint.x);
        const height = Math.abs(endPoint.y - startPoint.y);

        if (width >= 5 && height >= 5) {
            // Guard against double-fire (pointerup + pointercancel on some browsers)
            const now = Date.now();
            if (now - lastBboxCreatedAt < 150) {
                isDrawing = false;
                startPoint = null;
                return;
            }
            lastBboxCreatedAt = now;

            // Capture points for async callback
            const capturedStart = { ...startPoint };
            const capturedEnd = { ...endPoint };

            // Suggest Reading Order
            const newBox = {
                x: Math.min(startPoint.x, endPoint.x),
                y: Math.min(startPoint.y, endPoint.y),
                width: Math.abs(endPoint.x - startPoint.x),
                height: Math.abs(endPoint.y - startPoint.y)
            };
            const suggestedRO = getSuggestedReadingOrder(newBox);

            if (currentLabel) {
                // Automated Labeling Mode: Skip modal, use current filter
                addBboxAnnotation(capturedStart, capturedEnd, currentLabel, suggestedRO);
            } else {
                showLabelModal((selectedLabel, readingOrder) => {
                    if (selectedLabel) {
                        addBboxAnnotation(capturedStart, capturedEnd, selectedLabel, readingOrder);
                    } else {
                        render(); // Clear temporary box if cancelled
                    }
                }, '', suggestedRO);
            }
        }

        isDrawing = false;
        startPoint = null;
    } else if (isDrawing) {
        // Polygon click handling logic here if needed
    }
}

// Spatial sorting helper to suggest reading order
function getSuggestedReadingOrder(newBox) {
    if (annotations.length === 0) return 0;

    // Create a temporary list including the new box
    // But we don't know the exact reading order yet.
    // We want to find insertion index based on spatial sort.

    // Sort existing annotations spatially
    // If we assume existing reading_order is correct, we just find where newBox fits spatially.

    // Simple strategy:
    // Iterate through existing annotations (sorted by current reading_order).
    // Find the first annotation 'B' where newBox is visually BEFORE 'B'.
    // Then we insert before 'B'.
    // If not found, append.

    // Comparator: is A before B?
    const isBefore = (a, b) => {
        // Tolerance for line overlap
        const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        const minH = Math.min(a.height, b.height);

        // Same logical line: extensive vertical overlap
        if (yOverlap > minH * 0.5) {
            // Sort left-to-right
            return a.x < b.x;
        }

        // Different lines: Sort top-to-bottom
        // Use center Y? or Top? 
        // Top usually safer for text documents (unless slight skew).
        // Let's use Top with a small tolerance?
        // Actually, if no overlap, simple y check.
        // If A overlap B but < 50%, it's ambiguous.
        // Stick to simple Top check if not overlapping significantly.
        return a.y < b.y;
    };

    // Find insertion index
    // We look for the first item 'ann' such that newBox isBefore ann.
    // If so, we take its reading_order.

    // Ensure annotations are sorted by reading_order for this iteration
    const sortedAnns = [...annotations].sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

    for (const ann of sortedAnns) {
        if (isBefore(newBox, ann)) {
            return ann.reading_order !== undefined ? ann.reading_order : 0;
        }
    }

    // If not before any, return length (append)
    return annotations.length;
}

// Helpers
function getResizeHandle(pt, ann) {
    if (ann.type !== 'bbox') return null;

    // Screen coords:
    const sPt = imageToScreen(pt.x, pt.y);
    const sAnn = imageToScreen(ann.x, ann.y);
    const sAnnEnd = imageToScreen(ann.x + ann.width, ann.y + ann.height);

    const HS = 8; // Handle size in pixels

    // Check corners in screen space
    if (distSq(sPt, { x: sAnn.x, y: sAnn.y }) < HS * HS) return 'nw';
    if (distSq(sPt, { x: sAnnEnd.x, y: sAnn.y }) < HS * HS) return 'ne';
    if (distSq(sPt, { x: sAnnEnd.x, y: sAnnEnd.y }) < HS * HS) return 'se';
    if (distSq(sPt, { x: sAnn.x, y: sAnnEnd.y }) < HS * HS) return 'sw';

    return null;
}

// Returns index of polygon keypoint within hit radius of pt (image coords), or -1
function getPolygonKeypointAt(pt, ann) {
    if (!ann.points || ann.points.length === 0) return -1;
    const sPt = imageToScreen(pt.x, pt.y);
    const HIT = 10; // hit radius in screen pixels
    for (let i = 0; i < ann.points.length; i++) {
        const sp = imageToScreen(ann.points[i].x, ann.points[i].y);
        if (distSq(sPt, sp) < HIT * HIT) return i;
    }
    return -1;
}

// Convert a bbox annotation to a polygon (in-place). Returns the annotation.
function convertPolyToBbox(ann) {
    if ((ann.type !== 'polygon' && ann.type !== 'poly') || !ann.points || ann.points.length === 0) return ann;
    const xs = ann.points.map(p => p.x);
    const ys = ann.points.map(p => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    ann.type = 'bbox';
    ann.x = minX;
    ann.y = minY;
    ann.width = maxX - minX;
    ann.height = maxY - minY;
    // Keep points if they exist for possible revert/compatibility
    return ann;
}

function convertBboxToPoly(ann) {
    const { x, y, width, height } = ann;
    ann.type = 'polygon';
    ann.points = [
        { x: x, y: y }, // TL
        { x: x + width, y: y }, // TR
        { x: x + width, y: y + height }, // BR
        { x: x, y: y + height }  // BL
    ];
    // x/y/width/height kept for DB schema compat
    return ann;
}


function resizeAnnotation(ann, handle, pt) {
    // Keep rectangle
    let x1 = ann.x;
    let y1 = ann.y;
    let x2 = ann.x + ann.width;
    let y2 = ann.y + ann.height;

    if (handle.includes('w')) x1 = pt.x;
    if (handle.includes('e')) x2 = pt.x;
    if (handle.includes('n')) y1 = pt.y;
    if (handle.includes('s')) y2 = pt.y;

    // Normalize (ensure width/height positive)
    // Normalize (ensure width/height positive)
    ann.x = Math.max(0, Math.min(Math.min(x1, x2), currentImage.width));
    ann.y = Math.max(0, Math.min(Math.min(y1, y2), currentImage.height));

    // Clamp width/height to image bounds from (x,y)
    ann.width = Math.min(Math.abs(x2 - x1), currentImage.width - ann.x);
    ann.height = Math.min(Math.abs(y2 - y1), currentImage.height - ann.y);
}

function distSq(p1, p2) {
    return Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
}

function handleWheel(e) {
    e.preventDefault();

    if (!currentImage) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check if mouse is over the image
    const imgPt = screenToImage(mouseX, mouseY);
    const onImage = imgPt.x >= 0 && imgPt.x <= currentImage.width &&
        imgPt.y >= 0 && imgPt.y <= currentImage.height;

    if (e.ctrlKey && onImage) {
        // Zoom Logic
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const oldScale = scale;
        scale *= delta;
        scale = Math.max(0.1, Math.min(scale, 5));

        offsetX = mouseX - (mouseX - offsetX) * (scale / oldScale);
        offsetY = mouseY - (mouseY - offsetY) * (scale / oldScale);
    } else {
        // Scroll Logic (Pan Vertical)
        // Only allow scrolling if the image is zoomed in beyond the fitScale
        if (scale > fitScale) {
            const scrollAmount = e.deltaY;
            offsetY -= scrollAmount;
        }
    }

    clampOffsets();
    render();
    updateZoomLevel();
    updateScrollbar();
}

// Coordinate transformations
function screenToImage(screenX, screenY) {
    return {
        x: (screenX - offsetX) / scale,
        y: (screenY - offsetY) / scale
    };
}

function imageToScreen(imgX, imgY) {
    return {
        x: imgX * scale + offsetX,
        y: imgY * scale + offsetY
    };
}

// Duplicate selected annotations
function duplicateSelectedAnnotations() {
    if (selectedAnnotations.size === 0 && !selectedAnnotation) return;

    saveUndoState();

    let targets = selectedAnnotations.size > 0 ? [...selectedAnnotations] : [selectedAnnotation];
    // Sort targets by their current index to handle multiple insertions correctly
    targets.sort((a, b) => annotations.indexOf(a) - annotations.indexOf(b));

    const newCopies = [];
    const OFFSET = 10; // offset in image pixels

    // We process in reverse to keep indices stable if we were using indices, 
    // but here we find index per item, so we process normally and the splice handles it.
    targets.forEach(ann => {
        const index = annotations.indexOf(ann);
        if (index === -1) return;

        // Deep copy the annotation
        const copy = JSON.parse(JSON.stringify(ann));

        // Remove ID to ensure it's treated as new by the backend
        delete copy.id;

        // Apply offset
        if (copy.type === 'bbox' || copy.type === 'keypoint') {
            copy.x += OFFSET;
            copy.y += OFFSET;
            // Constrain keypoint or bbox (x,y handled by create logic mostly, but let's be safe for keypoint)
            if (copy.type === 'keypoint') {
                copy.x = Math.max(0, Math.min(copy.x, currentImage.width));
                copy.y = Math.max(0, Math.min(copy.y, currentImage.height));
            } else {
                // Bbox constraint already handled by bbox logic if we moved it, 
                // but for duplication offset:
                copy.x = Math.max(0, Math.min(copy.x, currentImage.width - (copy.width || 0)));
                copy.y = Math.max(0, Math.min(copy.y, currentImage.height - (copy.height || 0)));
            }
        } else if (copy.type === 'polygon' && copy.points) {
            copy.points.forEach(p => {
                p.x += OFFSET;
                p.y += OFFSET;
                // Constrain points
                p.x = Math.max(0, Math.min(p.x, currentImage.width));
                p.y = Math.max(0, Math.min(p.y, currentImage.height));
            });
            // Update temporary bbox for polygon
            copy.x = Math.max(0, Math.min(copy.x + OFFSET, currentImage.width));
            copy.y = Math.max(0, Math.min(copy.y + OFFSET, currentImage.height));
        }

        // Insert immediately after original
        annotations.splice(index + 1, 0, copy);
        newCopies.push(copy);
    });

    // Re-calculate reading_order for ALL annotations based on new array order
    annotations.forEach((ann, idx) => {
        ann.reading_order = idx;
    });

    // Select the newly created copies
    selectedAnnotations.clear();
    newCopies.forEach(copy => selectedAnnotations.add(copy));
    selectedAnnotation = newCopies[0];

    render();
    renderAnnotationsList();
    updateToolbarState();
    saveAnnotations();
}

/**
 * Applies the manual sort sequence defined by sequential clicks.
 */
function applyManualSort() {
    if (manualSortSequence.length === 0) return;
    saveUndoState();

    // 1. Get the minimum reading order currently in the selected group to use as insertion point
    const currentOrders = manualSortSequence.map(ann => ann.reading_order ?? 0);
    const minOriginalOrder = Math.min(...currentOrders);

    // 2. Separate manual sequence from the rest
    const selectedSet = new Set(manualSortSequence);
    const unselectedGroup = annotations.filter(ann => !selectedSet.has(ann));

    // 3. Reconstruct the list: 
    // - Items that were BEFORE the group remain before
    // - Insert manualSortSequence
    // - Items that were AFTER the group remain after
    const before = unselectedGroup.filter(ann => (ann.reading_order ?? 0) < minOriginalOrder);
    const after = unselectedGroup.filter(ann => (ann.reading_order ?? 0) >= minOriginalOrder);

    annotations = [...before, ...manualSortSequence, ...after];

    // 4. Force global re-indexing to 0...N-1
    annotations.forEach((ann, i) => {
        ann.reading_order = i;
    });

    // 5. Sync state
    manualSortSequence = [];
    selectedAnnotations.clear();
    selectedAnnotation = null;

    const selectBtn = document.querySelector('[data-tool="select"]');
    if (selectBtn) selectBtn.click();

    render();
    renderAnnotationsList();
    saveAnnotations();
}

// Add annotations
function addBboxAnnotation(start, end, label, requestedReadingOrder = null) {
    saveUndoState();
    const useLabel = label || currentLabel;
    if (!useLabel) {
        alert('No label selected');
        return;
    }

    let x = Math.min(start.x, end.x);
    let y = Math.min(start.y, end.y);
    let width = Math.abs(end.x - start.x);
    let height = Math.abs(end.y - start.y);

    // Constrain to image bounds
    x = Math.max(0, Math.min(x, currentImage.width));
    y = Math.max(0, Math.min(y, currentImage.height));
    width = Math.min(width, currentImage.width - x);
    height = Math.min(height, currentImage.height - y);

    if (width < 5 || height < 5) return; // Too small

    // Calculate reading_order
    let ro = requestedReadingOrder;
    if (ro === null || ro === undefined || ro < 0) {
        ro = annotations.length; // Default append
    } else {
        // Shift subsequent items
        annotations.forEach(ann => {
            if ((ann.reading_order || 0) >= ro) {
                ann.reading_order = (ann.reading_order || 0) + 1;
            }
        });
    }

    const annotation = {
        type: 'bbox',
        label: useLabel,
        x,
        y,
        width,
        height,
        imageWidth: currentImage.width,
        imageHeight: currentImage.height,
        reading_order: ro,
        content: ''
    };

    // Sort by reading_order to keep array consistent with visual order
    annotations.push(annotation);
    annotations.sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

    selectAnnotation(annotation); // Auto-select new box
    render();
    renderAnnotationsList();
    saveAnnotations(); // Force save to meet user requirement
}

function finishPolygon() {
    if (tempPoints.length < 3) return;
    saveUndoState();

    // Suggest Reading Order
    let minX = currentImage.width, minY = currentImage.height, maxX = 0, maxY = 0;
    tempPoints.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    });
    const newBox = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
    const suggestedRO = getSuggestedReadingOrder(newBox);

    if (currentLabel) {
        // Automated Labeling Mode
        const annotation = {
            type: 'polygon',
            label: currentLabel,
            points: [...tempPoints],
            x: newBox.x,
            y: newBox.y,
            width: newBox.width,
            height: newBox.height,
            imageWidth: currentImage.width,
            imageHeight: currentImage.height,
            reading_order: annotations.length,
            content: ''
        };
        annotations.push(annotation);

        // Reset state
        tempPoints = [];
        isDrawing = false;
        isHoveringFirstPoint = false;

        selectAnnotation(annotation); // Auto-select new polygon
        sortLayouts();
    } else {
        showLabelModal((label, requestedReadingOrder) => {
            if (!label) {
                // Cancelled
                tempPoints = [];
                isDrawing = false;
                isHoveringFirstPoint = false;
                render();
                return;
            }

            // Calculate reading_order
            let ro = requestedReadingOrder;
            if (ro === null || ro === undefined || ro < 0) {
                ro = annotations.length;
            } else {
                annotations.forEach(ann => {
                    if ((ann.reading_order || 0) >= ro) {
                        ann.reading_order = (ann.reading_order || 0) + 1;
                    }
                });
            }

            const annotation = {
                type: 'polygon',
                label: label,
                points: [...tempPoints],
                x: newBox.x,
                y: newBox.y,
                width: newBox.width,
                height: newBox.height,
                imageWidth: currentImage.width,
                imageHeight: currentImage.height,
                reading_order: ro,
                content: ''
            };

            annotations.push(annotation);
            annotations.sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

            // Reset drawing state
            tempPoints = [];
            isDrawing = false;
            isHoveringFirstPoint = false;

            selectAnnotation(annotation); // Auto-select new polygon
            render();
            renderAnnotationsList();
            saveAnnotations();
        }, '', suggestedRO);
    }
}


function addKeypointAnnotation(point) {
    saveUndoState();
    // Suggest Reading Order
    const newBox = {
        x: point.x,
        y: point.y,
        width: 1, // Minimal size
        height: 1
    };
    const suggestedRO = getSuggestedReadingOrder(newBox);

    if (currentLabel) {
        // Automated Labeling Mode
        const annotation = {
            type: 'keypoint',
            label: currentLabel,
            x: point.x,
            y: point.y,
            imageWidth: currentImage.width,
            imageHeight: currentImage.height,
            reading_order: annotations.length,
            content: ''
        };
        annotations.push(annotation);
        selectAnnotation(annotation); // Auto-select new keypoint
        sortLayouts();
    } else {
        showLabelModal((label, requestedReadingOrder) => {
            if (!label) return;

            // Calculate reading_order
            let ro = requestedReadingOrder;
            if (ro === null || ro === undefined || ro < 0) {
                ro = annotations.length;
            } else {
                annotations.forEach(ann => {
                    if ((ann.reading_order || 0) >= ro) {
                        ann.reading_order = (ann.reading_order || 0) + 1;
                    }
                });
            }

            const annotation = {
                type: 'keypoint',
                label: label,
                x: point.x,
                y: point.y,
                imageWidth: currentImage.width,
                imageHeight: currentImage.height,
                reading_order: ro,
                content: ''
            };

            annotations.push(annotation);
            annotations.sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

            selectAnnotation(annotation); // Auto-select new keypoint
            render();
            renderAnnotationsList();
            saveAnnotations();
        }, '', suggestedRO);
    }
}

// ====== UI Color & Blink Helpers ======
const LABEL_COLORS = [
    '#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#ec4899',
    '#06b6d4', '#84cc16', '#6366f1', '#f43f5e', '#14b8a6', '#d946ef',
    '#a855f7', '#0ea5e9', '#db2777'
];

const KNOWN_LABEL_COLORS = {
    'text': '#3b82f6',      // Blue
    'title': '#ef4444',     // Red
    'section': '#8b5cf6',   // Purple
    'header': '#eab308',    // Yellow (was Green 700)
    'footer': '#06b6d4',    // Cyan
    'table': '#10b981',     // Emerald
    'figure': '#ec4899',    // Pink
    'list': '#84cc16',      // Lime
    'equation': '#6366f1',  // Indigo
    'logo': '#14b8a6',      // Teal
    'signature': '#d946ef', // Fuchsia
    'stamp': '#dc2626',     // Red 600 (was Orange)
    'barcode': '#64748b',   // Slate
    'qrcode': '#a855f7',    // Violet
    'stamp_name': '#be185d',// Pink 700 (was Yellow)
    'page_number': '#0ea5e9', // Sky
    'checkbox': '#f43f5e',  // Rose
    'checkedbox': '#db2777' // Secondary Rose
};

function getStringColor(str) {
    if (!str) return '#6b7280';
    const lower = str.toLowerCase();
    if (KNOWN_LABEL_COLORS[lower]) {
        return KNOWN_LABEL_COLORS[lower];
    }
    
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length];
}

function getRgbaColor(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getBoundingBox(ann) {
    if (ann.type === 'bbox') {
        return { x: ann.x, y: ann.y, w: ann.width, h: ann.height };
    } else if (ann.type === 'polygon' && ann.points && ann.points.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of ann.points) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return null;
}

function calculateOverlapRatio(ann1, ann2) {
    const bb1 = getBoundingBox(ann1);
    const bb2 = getBoundingBox(ann2);
    if (!bb1 || !bb2) return 0;

    const xLeft = Math.max(bb1.x, bb2.x);
    const yTop = Math.max(bb1.y, bb2.y);
    const xRight = Math.min(bb1.x + bb1.w, bb2.x + bb2.w);
    const yBottom = Math.min(bb1.y + bb1.h, bb2.y + bb2.h);

    if (xRight <= xLeft || yBottom <= yTop) return 0;

    const intersectionArea = (xRight - xLeft) * (yBottom - yTop);
    const area1 = bb1.w * bb1.h;
    const area2 = bb2.w * bb2.h;
    
    // Check overlap ratio against the smaller box
    const minArea = Math.min(area1, area2);
    if (minArea === 0) return 0;
    return intersectionArea / minArea;
}

let isBlinkPhase = false;
let isBlinkEnabled = true;

document.addEventListener('DOMContentLoaded', () => {
    const blinkBtn = document.getElementById('toggleBlinkBtn');
    if (blinkBtn) {
        blinkBtn.addEventListener('click', () => {
            isBlinkEnabled = !isBlinkEnabled;
            // Visual feedback on button
            blinkBtn.style.color = isBlinkEnabled ? '#3b82f6' : 'var(--text-muted)';
            if (!isBlinkEnabled) {
                // Force a render to clear current blinking highlights
                scheduleRender();
            }
        });
    }
});

setInterval(() => {
    isBlinkPhase = !isBlinkPhase;
    if (isBlinkEnabled && annotations && annotations.some(ann => ann._isBlinking)) {
        scheduleRender();
    }
}, 400);
// ======================================

// Render canvas
function render() {
    if (!ctx || !canvas) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!currentImage) return;

    // Draw image
    ctx.drawImage(
        currentImage,
        offsetX,
        offsetY,
        currentImage.width * scale,
        currentImage.height * scale
    );

    // Calculate >90% overlaps for blinking
    const visibleAnns = annotations.filter(ann => {
        if (currentLabel && ann.label !== currentLabel) return false;
        if (hiddenAnnotations.has(ann)) return false;
        if (visibleLabels !== null && !visibleLabels.has(ann.label)) return false;
        return true;
    });

    annotations.forEach(ann => ann._isBlinking = false);

    for (let i = 0; i < visibleAnns.length; i++) {
        for (let j = i + 1; j < visibleAnns.length; j++) {
            if (calculateOverlapRatio(visibleAnns[i], visibleAnns[j]) > 0.9) {
                visibleAnns[i]._isBlinking = true;
                visibleAnns[j]._isBlinking = true;
            }
        }
    }

    // Draw annotations
    annotations.forEach((ann, idx) => {
        // Filter by label if selected
        if (currentLabel && ann.label !== currentLabel) return;
        if (hiddenAnnotations.has(ann)) return; // skip hidden
        if (visibleLabels !== null && !visibleLabels.has(ann.label)) return; // skip label-filtered

        const isSelected = selectedAnnotation === ann || selectedAnnotations.has(ann);
        const labelColor = getStringColor(ann.label);
        const isBlinkingNow = isBlinkEnabled && ann._isBlinking && isBlinkPhase;

        if (ann.type === 'bbox') {
            const start = imageToScreen(ann.x, ann.y);
            const end = imageToScreen(ann.x + ann.width, ann.y + ann.height);

            const isBbox2Poly = currentTool === 'bbox2poly';
            const isPoly2Bbox = currentTool === 'poly2bbox';
            
            if (isBlinkingNow) {
                ctx.strokeStyle = '#ef4444'; // Red flash
                ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
            } else {
                ctx.strokeStyle = isSelected ? '#f59e0b' : (isBbox2Poly || isPoly2Bbox ? '#10b981' : labelColor);
            }
            
            ctx.lineWidth = isSelected || isBlinkingNow ? 3 : 2;
            if (isBbox2Poly && isSelected) ctx.setLineDash([6, 3]);
            ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
            if (isBlinkingNow) {
                 ctx.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
            }
            ctx.setLineDash([]);

            // Manual Sort Highlighting
            if (currentTool === 'manual_sort' && selectedAnnotations.has(ann)) {
                ctx.fillStyle = manualSortSequence.includes(ann) ? 'rgba(139, 92, 246, 0.3)' : 'rgba(245, 158, 11, 0.3)';
                ctx.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
            }

            // In bbox2poly, poly2bbox, or rotate mode show draggable corner handles
            if ((isBbox2Poly || isPoly2Bbox || currentTool === 'rotate') && isSelected) {
                const corners = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
                corners.forEach(c => {
                    ctx.fillStyle = '#f59e0b';
                    ctx.strokeStyle = 'white';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                });
            }

            // Label & Reading Order
            if (showLabels) {
                ctx.font = '18px sans-serif';

                let roText = '';
                if (ann.reading_order !== undefined && ann.reading_order !== null) {
                    roText = `[${ann.reading_order}] `;
                }

                const roWidth = ctx.measureText(roText).width;

                // Draw Background for text readability
                const labelText = ann.label || '';
                const labelWidth = ctx.measureText(labelText).width;
                const totalWidth = roWidth + labelWidth;

                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.fillRect(start.x, start.y - 14, totalWidth + 4, 14);

                // Draw Reading Order in Red
                if (roText) {
                    ctx.fillStyle = 'red'; // Consistent red color
                    ctx.fillText(roText, start.x + 2, start.y - 3);
                }

                // Draw Label
                ctx.fillStyle = isSelected ? '#f59e0b' : labelColor;
                ctx.fillText(labelText, start.x + 2 + roWidth, start.y - 3);
            }
        } else if (ann.type === 'polygon' || ann.type === 'poly') {
            const labelColor = getStringColor(ann.label);
            const isBlinkingNow = isBlinkEnabled && ann._isBlinking && isBlinkPhase;
            const isPoly2Bbox = currentTool === 'poly2bbox';

            if (isBlinkingNow) {
                ctx.strokeStyle = '#ef4444';
                ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
            } else {
                ctx.strokeStyle = isSelected ? '#f59e0b' : (isPoly2Bbox ? '#10b981' : labelColor);
                ctx.fillStyle = isSelected ? 'rgba(245, 158, 11, 0.2)' : getRgbaColor(labelColor, 0.2);
            }
            ctx.lineWidth = isSelected || isBlinkingNow ? 3 : 2;
            if (isPoly2Bbox && isSelected) ctx.setLineDash([6, 3]);

            ctx.beginPath();
            const firstPoint = imageToScreen(ann.points[0].x, ann.points[0].y);
            ctx.moveTo(firstPoint.x, firstPoint.y);

            for (let i = 1; i < ann.points.length; i++) {
                const point = imageToScreen(ann.points[i].x, ann.points[i].y);
                ctx.lineTo(point.x, point.y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw keypoint handles when selected
            if (isSelected) {
                ann.points.forEach((p, idx) => {
                    const sp = imageToScreen(p.x, p.y);
                    const isActive = isDraggingPoint && draggingPointIndex === idx;
                    ctx.fillStyle = isActive ? '#ef4444' : '#f59e0b';
                    ctx.strokeStyle = 'white';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                });
            }

            // Label & Reading Order
            if (showLabels) {
                ctx.font = 'bold 18px sans-serif';

                let roText = '';
                if (ann.reading_order !== undefined && ann.reading_order !== null) {
                    roText = `[${ann.reading_order}] `;
                }

                const roWidth = ctx.measureText(roText).width;

                // Draw Background
                const labelText = ann.label || '';
                const labelWidth = ctx.measureText(labelText).width;
                const totalWidth = roWidth + labelWidth;

                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.fillRect(firstPoint.x, firstPoint.y - 14, totalWidth + 4, 14);

                // Draw Reading Order in Red
                if (roText) {
                    ctx.fillStyle = 'red';
                    ctx.fillText(roText, firstPoint.x + 2, firstPoint.y - 3);
                }

                // Draw Label
                ctx.fillStyle = isSelected ? '#f59e0b' : labelColor;
                ctx.fillText(labelText, firstPoint.x + 2 + roWidth, firstPoint.y - 3);
            }
        } else if (ann.type === 'keypoint') {
            const point = imageToScreen(ann.x, ann.y);

            ctx.fillStyle = isSelected ? '#f59e0b' : '#10b981';
            ctx.beginPath();
            ctx.arc(point.x, point.y, isSelected ? 6 : 4, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Label
            if (showLabels) {
                ctx.fillStyle = isSelected ? '#f59e0b' : '#10b981';
                ctx.font = '12px sans-serif';
                ctx.fillText(ann.label, point.x + 8, point.y - 8);
            }
        }
    });

    // Draw temp polygon points
    if (tempPoints.length > 0) {
        ctx.strokeStyle = '#3b82f6';
        ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
        ctx.lineWidth = 2;

        ctx.beginPath();
        const firstPoint = imageToScreen(tempPoints[0].x, tempPoints[0].y);
        ctx.moveTo(firstPoint.x, firstPoint.y);

        for (let i = 1; i < tempPoints.length; i++) {
            const point = imageToScreen(tempPoints[i].x, tempPoints[i].y);
            ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();

        // Draw points
        // Draw points
        tempPoints.forEach((p, idx) => {
            const point = imageToScreen(p.x, p.y);
            ctx.fillStyle = '#3b82f6';
            ctx.beginPath();

            // Highlight first point if hovering
            if (idx === 0 && isHoveringFirstPoint) {
                ctx.fillStyle = '#ef4444'; // Red-500
                ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); // Larger
            } else {
                ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
            }

            ctx.fill();
        });
    }

    // Draw manual sort sequence overlays
    if (currentTool === 'manual_sort' && manualSortSequence.length > 0) {
        manualSortSequence.forEach((ann, i) => {
            const start = imageToScreen(ann.x, ann.y);
            const centerX = start.x + (ann.width * scale) / 2;
            const centerY = start.y + (ann.height * scale) / 2;

            ctx.fillStyle = '#8b5cf6'; // Purple-500
            ctx.beginPath();
            ctx.arc(centerX, centerY, 15, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'white';
            ctx.font = 'bold 16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i + 1, centerX, centerY);
        });
        // Reset text baseline/align
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
    }

    // Draw selection box if drawing
    if (isSelectionBoxDrawing && selectionBoxStart && selectionBoxEnd) {
        const start = imageToScreen(selectionBoxStart.x, selectionBoxStart.y);
        const end = imageToScreen(selectionBoxEnd.x, selectionBoxEnd.y);

        ctx.strokeStyle = '#6366f1';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1;
        ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
        ctx.fillStyle = 'rgba(99, 102, 241, 0.1)';
        ctx.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
        ctx.setLineDash([]);
    }

    // Live bbox drawing preview (uses mousePos, avoids post-render direct ctx calls)
    if (isDrawing && currentTool === 'bbox' && startPoint) {
        const cur = screenToImage(mousePos.x, mousePos.y);
        const imgStart = imageToScreen(startPoint.x, startPoint.y);
        const imgEnd = imageToScreen(cur.x, cur.y);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.strokeRect(imgStart.x, imgStart.y, imgEnd.x - imgStart.x, imgEnd.y - imgStart.y);
    }

    // Live polygon drawing preview
    if (isDrawing && currentTool === 'polygon' && tempPoints.length > 0) {
        const lastPt = tempPoints[tempPoints.length - 1];
        const start = imageToScreen(lastPt.x, lastPt.y);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
    }
}

// Schedules a render on the next animation frame, coalescing multiple calls within the same frame.
function scheduleRender() {
    if (!_scheduleRafId) {
        _scheduleRafId = requestAnimationFrame(() => {
            _scheduleRafId = null;
            render();
        });
    }
}

// Label Popup Logic
// Label Modal Logic
function getLabelColor(label) {
    const l = label.toLowerCase();
    if (l.includes('text')) return '#e2e8f0'; // Slate 200
    if (l.includes('title')) return '#fecaca'; // Red 200
    if (l.includes('list')) return '#bbf7d0'; // Green 200
    if (l.includes('table')) return '#ccfbf1'; // Teal 100
    if (l.includes('figure')) return '#ddd6fe'; // Violet 200
    if (l.includes('header') || l.includes('footer')) return '#e9d5ff'; // Purple 200
    if (l.includes('section')) return '#fbcfe8'; // Pink 200
    if (l.includes('caption')) return '#bfdbfe'; // Blue 200
    return '#f3f4f6'; // Gray 100
}

function showLabelModal(onSelect, prefillLabel = null, prefillReadingOrder = null, isBatch = false) {
    const modal = document.getElementById('labelModal');
    const list = document.getElementById('modalLabelList');
    const labelSelect = document.getElementById('labelSelect');
    const input = document.getElementById('customLabelInput');
    const roInput = document.getElementById('readingOrderInput');
    const confirmBtn = document.getElementById('confirmLabelBtn');
    const cancelBtn = document.getElementById('cancelLabelBtn');
    const closeBtn = document.getElementById('closeModalBtn');
    const roContainer = document.getElementById('readingOrderContainer');

    // Show/Hide Reading Order for batch edits
    if (roContainer) {
        roContainer.style.display = isBatch ? 'none' : 'block';
    }

    // Clear previous state
    list.innerHTML = '';
    input.value = prefillLabel || lastUsedLabel || '';

    // Prefill Reading Order: default to annotations.length (next available) definition
    // If editing existing (prefillReadingOrder passed), use it.
    // If creating new (prefillReadingOrder null), use default.
    if (prefillReadingOrder !== null && prefillReadingOrder !== undefined) {
        roInput.value = prefillReadingOrder;
    } else {
        roInput.value = annotations.length;
    }

    // UI Logic
    const closeModal = () => {
        modal.style.display = 'none';
        modal.onclick = null; // Clear backdrop click
    };

    const cancelModal = () => {
        closeModal();
        onSelect(null);
    };

    const confirmLabel = () => {
        saveUndoState();
        const val = input.value.trim();
        const roVal = roInput.value.trim() !== '' ? parseInt(roInput.value.trim()) : null;

        if (val) {
            lastUsedLabel = val; // Store it for next time
            // If label is new (not in suggested list), add it
            const exists = Array.from(labelSelect.options).some(o => o.value === val);
            if (!exists) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.text = val;
                labelSelect.appendChild(opt);
                // Also persist to dataset labels on server if possible
                if (currentDataset?.id) {
                    const updatedLabels = Array.from(labelSelect.options)
                        .filter(o => o.value)
                        .map(o => o.value);
                    fetch(`${API_BASE}/datasets/${currentDataset.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: currentDataset.name,
                            description: currentDataset.description || '',
                            labels: updatedLabels
                        })
                    }).catch(e => console.warn('Could not persist new label:', e));
                }
            }
            closeModal();
            onSelect(val, roVal);
        }
    };

    // Close on confirm/cancel
    confirmBtn.onclick = confirmLabel;
    cancelBtn.onclick = cancelModal;
    closeBtn.onclick = cancelModal;

    // Populate suggestions
    Array.from(labelSelect.options).forEach(opt => {
        if (!opt.value) return;

        const btn = document.createElement('div');
        btn.textContent = opt.text;
        btn.className = 'btn';
        // Add minimal style for div button look
        btn.style.padding = '8px';
        btn.style.border = '1px solid #e5e7eb';
        const color = getLabelColor(opt.text);
        btn.style.background = color;
        btn.style.color = 'black';
        btn.style.fontWeight = '500';
        btn.style.cursor = 'pointer';
        btn.style.borderRadius = '4px';
        btn.style.fontSize = '13px';
        btn.style.textAlign = 'center';

        if (opt.value === prefillLabel) {
            btn.style.border = '2px solid black';
            btn.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.2)';
        }

        btn.onmouseenter = () => btn.style.filter = 'brightness(0.95)';
        btn.onmouseleave = () => btn.style.filter = 'brightness(1)';

        btn.onclick = () => {
            // Update input
            input.value = opt.text;

            // Visual feedback (Selection)
            Array.from(list.children).forEach(child => {
                child.style.border = '1px solid #e5e7eb';
                child.style.boxShadow = 'none';
            });
            btn.style.border = '2px solid black';
            btn.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.2)';
        };

        list.appendChild(btn);
    });


    input.onkeydown = (e) => {
        if (e.key === 'Enter') confirmLabel();
        if (e.key === 'Escape') cancelModal();
    };

    // Show modal
    modal.style.display = 'flex';
    input.focus();

    // Close on backdrop click (optional but good)
    modal.onclick = (e) => {
        if (e.target === modal) cancelModal();
    };
}


// Find annotation at position
function findAnnotationAt(screenX, screenY) {
    const imgPoint = screenToImage(screenX, screenY);

    for (let i = annotations.length - 1; i >= 0; i--) {
        const ann = annotations[i];
        if (hiddenAnnotations.has(ann)) continue; // not interactive when hidden
        if (visibleLabels !== null && !visibleLabels.has(ann.label)) continue; // not interactive when label-filtered
        if (currentLabel && ann.label !== currentLabel) continue; // not interactive when currentLabel filtered

        if (ann.type === 'bbox') {
            if (imgPoint.x >= ann.x && imgPoint.x <= ann.x + ann.width &&
                imgPoint.y >= ann.y && imgPoint.y <= ann.y + ann.height) {
                return ann;
            }
        } else if (ann.type === 'keypoint') {
            const dist = Math.sqrt(
                Math.pow(imgPoint.x - ann.x, 2) + Math.pow(imgPoint.y - ann.y, 2)
            );
            if (dist < 10 / scale) {
                return ann;
            }
        } else if (ann.type === 'polygon') {
            if (pointInPolygon(imgPoint, ann.points)) {
                return ann;
            }
        }
    }

    return null;
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;

        const intersect = ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Find ALL annotations from a given pool (Set) that contain the screen point
function findAllAnnotationsAt(screenX, screenY, pool) {
    const imgPoint = screenToImage(screenX, screenY);
    const results = [];
    for (let i = annotations.length - 1; i >= 0; i--) {
        const ann = annotations[i];
        if (!pool.has(ann)) continue;
        if (hiddenAnnotations.has(ann)) continue;
        if (visibleLabels !== null && !visibleLabels.has(ann.label)) continue; // not interactive when label-filtered
        if (currentLabel && ann.label !== currentLabel) continue; // not interactive when currentLabel filtered
        let hit = false;
        if (ann.type === 'bbox') {
            hit = imgPoint.x >= ann.x && imgPoint.x <= ann.x + ann.width &&
                imgPoint.y >= ann.y && imgPoint.y <= ann.y + ann.height;
        } else if (ann.type === 'keypoint') {
            hit = Math.hypot(imgPoint.x - ann.x, imgPoint.y - ann.y) < 10 / scale;
        } else if (ann.type === 'polygon') {
            hit = pointInPolygon(imgPoint, ann.points);
        }
        if (hit) results.push(ann);
    }
    return results;
}

// Assign the next sort sequence number to an annotation and hide picker
function assignSortSequence(ann) {
    if (manualSortSequence.includes(ann)) return;
    manualSortSequence.push(ann);
    hideOverlapPicker();
    if (manualSortSequence.length === selectedAnnotations.size) {
        applyManualSort();
    } else {
        render();
    }
}

// Crop an annotation's bounding region from currentImage into a data URL
function cropAnnotationToDataURL(ann, maxH = 72) {
    if (!currentImage) return null;
    // Use bounding box for all types (polygon bbox is kept in sync)
    const sx = Math.max(0, Math.floor(ann.x));
    const sy = Math.max(0, Math.floor(ann.y));
    const sw = Math.min(Math.ceil(ann.width || 10), currentImage.width - sx);
    const sh = Math.min(Math.ceil(ann.height || 10), currentImage.height - sy);
    if (sw <= 0 || sh <= 0) return null;

    const ratio = maxH / sh;
    const dw = Math.round(sw * ratio);
    const dh = maxH;

    const offscreen = document.createElement('canvas');
    offscreen.width = dw;
    offscreen.height = dh;
    const octx = offscreen.getContext('2d');
    octx.drawImage(currentImage, sx, sy, sw, sh, 0, 0, dw, dh);
    return offscreen.toDataURL('image/jpeg', 0.85);
}

// Show a temporary overlap picker panel in the sidebar
function showOverlapPicker(candidates) {
    overlapPickerActive = true;
    const list = document.getElementById('annotationsList');
    const nextNum = manualSortSequence.length + 1;

    const rows = candidates.map(ann => {
        const idx = annotations.indexOf(ann);
        const cropSrc = cropAnnotationToDataURL(ann);
        const cropImg = cropSrc
            ? `<img src="${cropSrc}" style="
                width:100%; max-height:72px; object-fit:cover;
                border-radius:4px; margin-top:4px;
                border:1px solid var(--border-color);">`
            : '';
        return `
        <div class="overlap-pick-item" data-pick-index="${idx}" style="
            display:flex; align-items:flex-start; gap:10px; padding:10px 12px;
            cursor:pointer; border-bottom:1px solid var(--border-color);
            transition: background 0.15s;
        ">
            <span style="
                min-width:26px; height:26px; border-radius:50%;
                background:var(--primary-color); color:white;
                display:flex; align-items:center; justify-content:center;
                font-size:13px; font-weight:bold; flex-shrink:0; margin-top:2px;
            ">${nextNum}</span>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ann.label}</div>
                ${cropImg}
            </div>
        </div>`;
    }).join('');

    list.innerHTML = `
        <div style="
            padding:10px 12px 8px; font-size:12px; font-weight:700;
            color:var(--primary-color); border-bottom:2px solid var(--primary-color);
            background:rgba(99,102,241,0.07); display:flex; gap:8px; align-items:center;
        ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
            </svg>
            Chọn box #${nextNum} (${candidates.length} box chồng nhau)
        </div>
        ${rows}
        <div style="padding:8px 12px;">
            <button id="cancelOverlapPickerBtn" style="
                width:100%; padding:6px; border:none; border-radius:6px;
                background:var(--bg-secondary); color:var(--text-secondary);
                cursor:pointer; font-size:12px;
            ">Hủy</button>
        </div>
    `;

    list.querySelectorAll('.overlap-pick-item').forEach(item => {
        item.addEventListener('mouseenter', () => item.style.background = 'rgba(99,102,241,0.1)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => {
            const ann = annotations[parseInt(item.dataset.pickIndex)];
            if (ann) assignSortSequence(ann);
        });
    });

    const cancelBtn = list.querySelector('#cancelOverlapPickerBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', hideOverlapPicker);
}

// Hide the overlap picker and restore the normal annotations list
function hideOverlapPicker() {
    if (!overlapPickerActive) return;
    overlapPickerActive = false;
    renderAnnotationsList();
}

// Select annotation
function selectAnnotation(annotation, source = 'canvas') {
    selectedAnnotation = annotation;
    if (annotation) {
        selectedAnnotations.clear();
        selectedAnnotations.add(annotation);
        manualSortSequence = []; // Reset sequence if single selection changes
    } else {
        selectedAnnotations.clear();
        manualSortSequence = []; // Reset sequence on deselection
        resetManipulationSliders();
    }
    render();

    document.querySelectorAll('.annotation-item').forEach(item => {
        item.classList.remove('selected');
    });

    const index = annotations.indexOf(annotation);
    const item = document.querySelector(`.annotation-item[data-index="${index}"]`);
    if (item) {
        item.classList.add('selected');
        // Only scroll if selected from canvas AND item is off-screen
        if (source !== 'list') {
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    updateToolbarState();
}

function updateToolbarState() {
    const deleteBtn = document.getElementById('deleteAnnotationBtn');
    if (deleteBtn) {
        const hasSelection = (selectedAnnotation !== null) || (selectedAnnotations.size > 0);
        deleteBtn.disabled = !hasSelection;
    }

    const mergeBtn = document.getElementById('mergeAnnotationsBtn');
    if (mergeBtn) {
        mergeBtn.disabled = (selectedAnnotations.size < 2);
    }

    const rotationControls = document.getElementById('rotationControls');
    if (rotationControls) {
        if (currentTool === 'rotate') {
            rotationControls.style.display = 'flex';
        } else {
            rotationControls.style.display = 'none';
        }
    }
}

function resetManipulationSliders() {
    const rotSlider = document.getElementById('rotationSlider');
    const scaleSlider = document.getElementById('scaleSlider');
    const rotVal = document.getElementById('rotationValue');
    const scaleValDisp = document.getElementById('scaleValue');

    if (rotSlider) rotSlider.value = 0;
    if (scaleSlider) scaleSlider.value = 1.0;
    if (rotVal) rotVal.textContent = '0.0°';
    if (scaleValDisp) scaleValDisp.textContent = '1.00x';
}

// ... (Rest of file) ...
// Update call sites:

// In handleMouseDown (line 348 approx)
// selectAnnotation(clicked, 'canvas'); 

// In renderAnnotationsList (line 1198 approx)
// item.addEventListener('click', () => {
//    selectAnnotation(annotations[originalIndex], 'list');
// });

// Delete annotation
function deleteSelectedAnnotation() {
    if (selectedAnnotations.size === 0 && !selectedAnnotation) return;
    saveUndoState();

    if (selectedAnnotations.size > 0) {
        // Bulk delete
        selectedAnnotations.forEach(ann => {
            const index = annotations.indexOf(ann);
            if (index > -1) {
                annotations.splice(index, 1);
            }
        });
        selectedAnnotations.clear();
        selectedAnnotation = null;
    } else if (selectedAnnotation) {
        // Single delete
        const index = annotations.indexOf(selectedAnnotation);
        if (index > -1) {
            annotations.splice(index, 1);
        }
        selectedAnnotation = null;
    }

    // Immediate Re-indexing of Reading Order for all
    annotations.forEach((a, i) => {
        a.reading_order = i;
    });

    render();
    renderAnnotationsList();
    updateToolbarState();
    saveAnnotations(); // Persist to server
}

// Render annotations list
// Render annotations list
function renderAnnotationsList() {
    const list = document.getElementById('annotationsList');
    document.getElementById('annotationCount').textContent = annotations.length;

    if (annotations.length === 0) {
        list.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">No annotations</div>';
        return;
    }

    // Capture current scroll position
    const savedScrollTop = list.scrollTop;

    // Cancel previous render loop if any
    if (renderRequestId) {
        cancelAnimationFrame(renderRequestId);
        renderRequestId = null;
    }

    list.innerHTML = '';
    const chunkSize = 20; // Smaller chunk for responsiveness
    let renderedCount = 0;

    const renderChunk = () => {
        const chunk = annotations.slice(renderedCount, renderedCount + chunkSize);
        if (chunk.length === 0) {
            // Extra safety: nothing to render but we're done
            renderRequestId = null;
            return;
        }

        const html = chunk.map((ann, idx) => {
            const globalIndex = renderedCount + idx;
            // Filter by label if selected (single-label mode)
            if (currentLabel && ann.label !== currentLabel) return '';
            // Multi-label visibility filter (null = show all)
            if (visibleLabels !== null && !visibleLabels.has(ann.label)) return '';

            let coords = '';
            if (ann.type === 'bbox') {
                const x1 = Math.round(ann.x);
                const y1 = Math.round(ann.y);
                const x2 = Math.round(ann.x + ann.width);
                const y2 = Math.round(ann.y + ann.height);
                coords = `x1:${x1} y1:${y1} x2:${x2} y2:${y2}`;
            } else if (ann.type === 'keypoint') {
                coords = `x:${Math.round(ann.x)} y:${Math.round(ann.y)}`;
            } else if (ann.type === 'polygon') {
                coords = `${ann.points.length} points`;
            }

            const contentRaw = ann.content || '';
            // Escape HTML to prevent layout breakage
            const escapeHtml = (unsafe) => {
                return unsafe
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#039;");
            };

            let contentDisplay = contentRaw.length > 50 ? contentRaw.substring(0, 50) + '...' : contentRaw;
            contentDisplay = escapeHtml(contentDisplay);

            const contentHtml = contentDisplay ? `<div class="annotation-content" style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px; border-left: 2px solid var(--border-color); padding-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(contentRaw)}">${contentDisplay}</div>` : '';

            const roHtml = (ann.reading_order !== undefined && ann.reading_order !== null)
                ? `<span class="reading-order" style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; margin-right: 6px;">#${ann.reading_order}</span>`
                : '';

            const isDraggable = !currentLabel;
            const dragAttr = isDraggable ? 'draggable="true"' : '';
            const indexAttr = `data-index="${globalIndex}"`;
            const isSelected = selectedAnnotation === ann;
            const selectedClass = isSelected ? 'selected' : '';
            const isHidden = hiddenAnnotations.has(ann);
            const eyeOpacity = isHidden ? '0.35' : '1';
            const eyeTitle = isHidden ? 'Show annotation' : 'Hide annotation';
            const eyeIcon = isHidden
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            const hiddenStyle = isHidden ? 'opacity: 0.45;' : '';

            return `
      <div class="annotation-item ${selectedClass} pending-init" ${indexAttr} ${dragAttr} style="${!isDraggable ? 'cursor: default;' : ''} ${hiddenStyle}">
        <div class="annotation-item-header">
          <div style="display: flex; align-items: center;">
            ${roHtml}
            <span class="annotation-label">${ann.label}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="annotation-type">${ann.type}</span>
            <button class="eye-toggle" data-index="${globalIndex}" title="${eyeTitle}" style="background:none;border:none;cursor:pointer;padding:2px;opacity:${eyeOpacity};color:var(--text-secondary);line-height:0;">${eyeIcon}</button>
          </div>
        </div>
        ${contentHtml}
        <div class="annotation-coords">${coords}</div>
      </div>
    `;
        }).join('');

        list.insertAdjacentHTML('beforeend', html);

        // Initialize event listeners for new items
        const newItems = list.querySelectorAll('.annotation-item.pending-init');
        newItems.forEach(item => {
            item.classList.remove('pending-init');
            const originalIndex = parseInt(item.dataset.index);

            // Eye toggle — must be wired before the item click below
            const eyeBtn = item.querySelector('.eye-toggle');
            if (eyeBtn) {
                eyeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const ann = annotations[parseInt(eyeBtn.dataset.index)];
                    if (hiddenAnnotations.has(ann)) {
                        hiddenAnnotations.delete(ann);
                    } else {
                        hiddenAnnotations.add(ann);
                        // Deselect if just hidden
                        if (selectedAnnotation === ann || selectedAnnotations.has(ann)) {
                            selectedAnnotations.delete(ann);
                            if (selectedAnnotation === ann) {
                                selectedAnnotation = selectedAnnotations.size > 0 ? [...selectedAnnotations][0] : null;
                            }
                            updateToolbarState();
                        }
                    }
                    render();
                    updateShowAllBtn();
                    renderAnnotationsList();
                });
            }

            item.addEventListener('click', () => {
                selectAnnotation(annotations[originalIndex], 'list');
            });

            item.addEventListener('dblclick', () => {
                showContentEditor(annotations[originalIndex]);
            });

            // Add drag events
            item.addEventListener('dragstart', () => {
                item.classList.add('dragging');
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');

                // Reorder logic: Update state based on new DOM position
                const list = document.getElementById('annotationsList');
                const newOrder = [];
                list.querySelectorAll('.annotation-item').forEach((domItem, newIndex) => {
                    const originalIndex = parseInt(domItem.dataset.index);
                    const ann = annotations[originalIndex];
                    if (ann) {
                        ann.reading_order = newIndex;
                        newOrder.push(ann);
                    }
                });

                if (newOrder.length === annotations.length) {
                    annotations = newOrder;
                    render(); // Update canvas (reading order numbers)
                    renderAnnotationsList(); // Re-render list to update data-indices
                    saveAnnotations();
                } else {
                    console.warn('Reorder cancelled: Not all items are rendered yet.');
                }
            });
        });

        renderedCount += chunkSize;

        // Restore scroll immediately after every chunk so users never see a flash at scroll=0
        list.scrollTop = savedScrollTop;

        if (renderedCount < annotations.length) {
            renderRequestId = requestAnimationFrame(renderChunk);
        } else {
            // All chunks rendered — final highlight + conditional scrollIntoView
            renderRequestId = null;
            if (selectedAnnotation) {
                const index = annotations.indexOf(selectedAnnotation);
                const item = document.querySelector(`.annotation-item[data-index="${index}"]`);
                if (item) {
                    item.classList.add('selected');
                    // Only scroll if item is genuinely off-screen after scroll restore
                    requestAnimationFrame(() => {
                        const listRect = list.getBoundingClientRect();
                        const itemRect = item.getBoundingClientRect();
                        const isVisible = itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom;
                        if (!isVisible) {
                            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    });
                }
            }
        }
    };

    renderChunk();

    // Removed old synchronous event listener attachment code
}



// Old loadAnnotationsForImage was removed due to Promise.all inlining.

// Save annotations
async function saveAnnotations() {
    if (!currentDataset || !currentImageId) {
        console.error('Cannot save: missing dataset or image ID');
        return;
    }

    // 1. Synchronously FREEZE the exact state RIGHT NOW to prevent race conditions
    // if the user switches images while a save is pending.
    const url = `${API_BASE}/datasets/${currentDataset.id}/sync-annotations`;
    const payload = {
        imageId: currentImageId,
        annotations: annotations
    };

    // Immediately update the RAM cache with the fresh edits.
    // If we don't do this, navigating away and returning will load the stale prefetched data!
    const cached = prefetchCache.get(currentImageId);
    if (cached) {
        cached.annPromise = Promise.resolve(JSON.parse(JSON.stringify(annotations)));
    }

    // 2. Queue it if busy
    if (isSaving) {
        pendingSavePayload = { url, payload };
        return;
    }

    isSaving = true;

    // 3. Process the current request, and then loop as long as there is a pending payload
    let currentTask = { url, payload };

    while (currentTask) {
        pendingSavePayload = null; // Clear it so we don't infinitely loop

        try {
            const res = await fetch(currentTask.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentTask.payload)
            });

            if (res.status === 200) {
                // Show success feedback
                const btn = document.getElementById('saveAnnotationsBtn');
                if (btn) {
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Saved!';
                    btn.style.background = 'var(--success)';
                    setTimeout(() => {
                        // Ensure we don't accidentally wipe out a new feedback message
                        if (btn.innerHTML.includes('Saved!')) {
                            btn.innerHTML = originalText;
                            btn.style.background = '';
                        }
                    }, 1500);
                }
            } else {
                const errText = await res.text();
                console.error('Save failed:', errText);
            }
        } catch (error) {
            console.error('Error saving annotations:', error);
        }

        // Loop check to see if new saves piled up while we were fetching
        currentTask = pendingSavePayload;
    }

    isSaving = false;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCanvas);
} else {
    initCanvas();
}

// Handle right-click for polygon completion and batch label editing
document.addEventListener('contextmenu', (e) => {
    if (e.target === canvas) {
        if (currentTool === 'polygon' && tempPoints.length >= 3) {
            e.preventDefault();
            finishPolygon();
        } else if ((currentTool === 'select' || currentTool === 'rotate') && selectedAnnotations.size > 0) {
            e.preventDefault();

            // Critical: Reset interaction states before modal opens to prevent sticky dragging
            isDragging = false;
            isDrawing = false;
            isResizing = false;
            isDraggingPoint = false;

            showLabelModal((label) => {
                if (!label) return;

                saveUndoState();
                selectedAnnotations.forEach(ann => {
                    ann.label = label;
                    ann.color = getLabelColor(label);
                });

                render();
                renderAnnotationsList();
                saveAnnotations();
            }, '', null, true); // true for isBatch
        }
    }
});

// Keyboard shortcuts
// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Block shortcuts when typing in text inputs/textareas/contentEditable,
    // but allow global shortcuts (Ctrl+Z/Y/S) through even for non-text inputs like sliders.
    const isTextTarget = e.target.tagName === 'TEXTAREA' || e.target.isContentEditable ||
        (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'button');
    if (isTextTarget) return;
    // Also block non-global shortcuts when any input (including sliders) is focused
    const isGlobalShortcut = e.ctrlKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y' || e.key === 's' || e.key === 'S');
    if (!isGlobalShortcut && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.key === 'Escape') {
        const modal = document.getElementById('labelModal');
        const editorModal = document.getElementById('contentEditorModal');

        // Close Modals
        if (modal && modal.style.display === 'flex') {
            document.getElementById('cancelLabelBtn').click();
            return;
        }
        if (editorModal && editorModal.style.display === 'flex') {
            document.getElementById('cancelEditorBtn').click();
            return;
        }

        // Cancel Polygon
        if (currentTool === 'polygon') {
            tempPoints = [];
            isDrawing = false;
            isHoveringFirstPoint = false;
            render();
        }

        // Exit manual sort if active
        if (currentTool === 'manual_sort') {
            const selectBtn = document.querySelector('[data-tool="select"]');
            if (selectBtn) selectBtn.click();
            return;
        }

        // Clear selection state properly via selectAnnotation
        selectAnnotation(null);

    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.code === 'KeyZ')) {
        e.preventDefault();
        // Prevent shift modifier from executing normal undo instead of redo
        if (e.shiftKey) {
            redo();
            return;
        }
        if (currentTool === 'manual_sort' && manualSortSequence.length > 0) {
            manualSortSequence.pop();
            hideOverlapPicker();
            render();
        } else {
            undo();
        }
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || e.code === 'KeyY')) {
        e.preventDefault();
        redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedAnnotation || selectedAnnotations.size > 0)) {
        deleteSelectedAnnotation();
    } else if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveAnnotations();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
        // Select All: works in select, rotate, and manual_sort modes
        if (currentTool === 'select' || currentTool === 'rotate' || currentTool === 'manual_sort') {
            e.preventDefault();
            selectedAnnotations.clear();
            annotations.forEach(ann => {
                // Respect label filter if active
                if (currentLabel && ann.label !== currentLabel) return;
                // Respect sidebar multiselect filter
                if (visibleLabels !== null && !visibleLabels.has(ann.label)) return;
                // Respect hidden status
                if (hiddenAnnotations.has(ann)) return;

                selectedAnnotations.add(ann);
            });

            selectedAnnotation = selectedAnnotations.size > 0 ? [...selectedAnnotations][0] : null;

            render();
            renderAnnotationsList();
            updateToolbarState();
        }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        // Duplicate selected annotations
        if (currentTool === 'select' || currentTool === 'rotate') {
            e.preventDefault();
            duplicateSelectedAnnotations();
        } else {
            // If in nav mode (A/D/W), we still want D for next image
            // Only trigger duplicate if Ctrl is held
            e.preventDefault();
            duplicateSelectedAnnotations();
        }
    } else if (e.key.toLowerCase() === 'd') {
        // Next Image
        navigateImage(1);
    } else if (e.key.toLowerCase() === 'a') {
        // Previous Image
        navigateImage(-1);
    } else if (e.key.toLowerCase() === 'w') {
        // Activate BBox tool
        const bboxBtn = document.querySelector('[data-tool="bbox"]');
        if (bboxBtn) bboxBtn.click();
    } else if (e.key.toLowerCase() === 'q') {
        // Activate Select tool
        const selectBtn = document.querySelector('[data-tool="select"]');
        if (selectBtn) selectBtn.click();
    } else if (e.key.toLowerCase() === 'e') {
        // Activate BBox to Poly tool
        const eBtn = document.querySelector('[data-tool="bbox2poly"]');
        if (eBtn) eBtn.click();
    } else if (e.key.toLowerCase() === 'f') {
        // Activate Poly to BBox tool
        const fBtn = document.querySelector('[data-tool="poly2bbox"]');
        if (fBtn) fBtn.click();
    } else if (e.key.toLowerCase() === 'r') {
        // Activate Rotate tool
        const rBtn = document.querySelector('[data-tool="rotate"]');
        if (rBtn) rBtn.click();
    }
});

// --- Content Editor Implementation ---

function cropImageFromCanvas(ann) {
    if (!currentImage) return null;

    // Create a temporary canvas
    const tempCanvas = document.createElement('canvas');
    const tCtx = tempCanvas.getContext('2d');

    // Get annotation bounds in image coordinates
    let x, y, w, h;
    if (ann.type === 'bbox') {
        x = ann.x;
        y = ann.y;
        w = ann.width;
        h = ann.height;
    } else if (ann.type === 'polygon') {
        // Calculate bbox from polygon
        const xs = ann.points.map(p => p.x);
        const ys = ann.points.map(p => p.y);
        x = Math.min(...xs);
        y = Math.min(...ys);
        w = Math.max(...xs) - x;
        h = Math.max(...ys) - y;
    } else {
        return null;
    }

    // No padding, match bounding box exactly
    const padding = 0;
    x = Math.max(0, x - padding);
    y = Math.max(0, y - padding);
    w = Math.min(currentImage.width - x, w + padding * 2);
    h = Math.min(currentImage.height - y, h + padding * 2);

    tempCanvas.width = w;
    tempCanvas.height = h;

    tCtx.drawImage(currentImage, x, y, w, h, 0, 0, w, h);

    return tempCanvas.toDataURL();
}

function showContentEditor(ann) {
    const modal = document.getElementById('contentEditorModal');
    const previewImg = document.getElementById('editorImagePreview');
    const container = document.getElementById('editorContainer');
    const titleLabel = document.getElementById('editorTitleLabel');
    const saveBtn = document.getElementById('saveEditorBtn');
    const cancelBtn = document.getElementById('cancelEditorBtn');
    const closeBtn = document.getElementById('closeEditorBtn');
    const prevBtn = document.getElementById('prevEditorBtn');
    const nextBtn = document.getElementById('nextEditorBtn');
    const navLabel = document.getElementById('editorNavLabel');

    // Navigation state — scoped to this open
    const currentIndex = annotations.indexOf(ann);
    if (navLabel) navLabel.textContent = `${currentIndex + 1} / ${annotations.length}`;
    if (prevBtn) prevBtn.disabled = currentIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentIndex >= annotations.length - 1;

    // 1. Setup Image Preview
    const dataUrl = cropImageFromCanvas(ann);
    previewImg.src = dataUrl || '';

    // Zoom Logic
    let zoomLevel = 1.0;
    let initialFitWidth = 0;

    const updateZoom = () => {
        if (!initialFitWidth) {
            // Calculate baseline fit width (100% of container or natural width, whichever is smaller)
            const containerWidth = previewImg.parentElement.parentElement.clientWidth;
            const containerHeight = previewImg.parentElement.parentElement.clientHeight;
            const imgNaturalWidth = previewImg.naturalWidth;
            const imgNaturalHeight = previewImg.naturalHeight;

            if (imgNaturalWidth && imgNaturalHeight) {
                const ratio = Math.min(containerWidth / imgNaturalWidth, containerHeight / imgNaturalHeight, 1.0);
                initialFitWidth = imgNaturalWidth * ratio;
            } else {
                initialFitWidth = containerWidth; // Fallback
            }
        }

        const targetWidth = initialFitWidth * zoomLevel;
        previewImg.style.maxWidth = 'none';
        previewImg.style.maxHeight = 'none';
        previewImg.style.width = `${targetWidth}px`;
        previewImg.style.height = 'auto'; // Maintain aspect ratio
        previewImg.style.cursor = zoomLevel > 1.0 ? 'grab' : 'zoom-in';
    };

    // Reset state & handle image load
    zoomLevel = 1.0;
    initialFitWidth = 0;
    previewImg.onload = () => {
        initialFitWidth = 0; // Recalculate on load
        updateZoom();
    };
    // If already loaded (cached)
    if (previewImg.complete) {
        updateZoom();
    }

    previewImg.onwheel = (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            zoomLevel += delta;
            zoomLevel = Math.max(0.2, Math.min(zoomLevel, 5.0));
            updateZoom();
        }
    };

    // Button Listeners
    const zIn = document.getElementById('editorZoomInBtn');
    const zOut = document.getElementById('editorZoomOutBtn');
    const zReset = document.getElementById('editorZoomResetBtn');

    if (zIn) zIn.onclick = () => { zoomLevel += 0.1; zoomLevel = Math.min(zoomLevel, 5.0); updateZoom(); };
    if (zOut) zOut.onclick = () => { zoomLevel -= 0.1; zoomLevel = Math.max(zoomLevel, 0.2); updateZoom(); };
    if (zReset) zReset.onclick = () => { zoomLevel = 1.0; updateZoom(); };

    // 2. Setup Label Display & Layout
    const currentLabel = (ann.label || 'text').toLowerCase().trim();
    if (titleLabel) titleLabel.textContent = ` - ${currentLabel}`;

    const layoutWrapper = document.getElementById('editorLayoutWrapper');
    const imageContainer = document.querySelector('.image-preview-controls-container');

    if (layoutWrapper && imageContainer && container) {
        if (currentLabel === 'table') {
            layoutWrapper.style.flexDirection = 'row';
            imageContainer.style.flex = '1';
            imageContainer.style.width = '50%';
            container.style.flex = '1';
            container.style.width = '50%';
            // Increase modal width for table
            modal.querySelector('.modal-content').style.maxWidth = '95%';
        } else {
            layoutWrapper.style.flexDirection = 'column';
            imageContainer.style.flex = '1';
            imageContainer.style.width = '100%';
            imageContainer.style.minHeight = '200px';
            container.style.flex = '1';
            container.style.width = '100%';
            // Standard modal width
            modal.querySelector('.modal-content').style.maxWidth = '900px';
        }
    }

    // 3. Setup Editor based on Label
    const setupEditor = () => {
        container.innerHTML = '';
        const content = ann.content || '';

        if (currentLabel === 'table') {
            // Table Editor (ContentEditable Div)
            const editor = document.createElement('div');
            editor.className = 'editor-table';
            editor.contentEditable = true;
            if (!content.trim()) {
                editor.innerHTML = '<table border="1"><tr><td>Header 1</td><td>Header 2</td></tr><tr><td>Data 1</td><td>Data 2</td></tr></table>';
            } else {
                editor.innerHTML = content;
            }
            container.appendChild(editor);
        } else if (['formula', 'equation', 'equation_block'].includes((currentLabel || '').toLowerCase().trim())) {
            // Visual Math Editor using MathLive
            const mathField = document.createElement('math-field');
            mathField.className = 'editor-mathfield';
            mathField.value = content;

            // Styling
            mathField.style.width = '100%';
            mathField.style.minHeight = '150px';
            mathField.style.fontSize = '1.5em';
            mathField.style.border = '1px solid #ccc';
            mathField.style.borderRadius = '4px';
            mathField.style.padding = '10px';
            mathField.style.display = 'block';

            container.appendChild(mathField);

            // Focus
            setTimeout(() => mathField.focus(), 100);
        } else {
            // Default Text Editor
            const editor = document.createElement('textarea');
            editor.className = 'editor-textarea';
            editor.placeholder = 'Enter text content...';
            editor.value = content;
            container.appendChild(editor);
        }
    };

    setupEditor();

    // 4. Save Handler
    const saveHandler = () => {
        saveUndoState();
        let newContent = '';

        if (currentLabel === 'table') {
            const editor = container.querySelector('.editor-table');
            newContent = editor.innerHTML;
        } else if (['formula', 'equation', 'equation_block'].includes((currentLabel || '').toLowerCase().trim())) {
            const mathField = container.querySelector('math-field');
            newContent = mathField.value;
        } else {
            const editor = container.querySelector('textarea');
            newContent = editor.value;
        }

        // Update Annotation Content ONLY (Label is managed via Canvas)
        ann.content = newContent;

        // Visual updates
        render();
        renderAnnotationsList();
        saveAnnotations();

        closeModal();
    };

    // 5. Extract Handler
    const extractBtn = document.getElementById('extractContentBtn');
    const splitBtn = document.getElementById('splitLayoutsBtn');
    const modelSelect = document.getElementById('extractModelSelect');

    // Show/hide Split Layouts button based on model
    const onModelChange = () => {
        if (splitBtn) {
            const isMinerU = modelSelect.value === 'mineru_2_5';
            splitBtn.style.display = isMinerU ? 'flex' : 'none';
            
            // Adjust Extract button text for MinerU
            if (isMinerU) {
                extractBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                        <path d="M7.5 4.21l4.5 2.6 4.5-2.6M12 22V12" />
                    </svg>
                    Extract & Split`;
            } else {
                extractBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    Extract Context`;
            }
        }
    };
    if (modelSelect) {
        modelSelect.addEventListener('change', onModelChange);
        onModelChange(); // run once immediately
    }

    const splitHandler = async (mode = 'layout') => {
        if (!splitBtn) return;
        const isExtract = mode === 'extract';
        const targetBtn = isExtract ? extractBtn : splitBtn;
        const originalText = targetBtn.innerHTML;

        targetBtn.disabled = true;
        targetBtn.innerHTML = `<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4V20M4 12H20" stroke-linecap="round"/></svg> ${isExtract ? 'Extracting...' : 'Splitting...'}`;

        try {
            const imageData = cropImageFromCanvas(ann);
            if (!imageData) throw new Error('Could not crop image');

            // Calculate source bbox in image coords
            let sourceX, sourceY, sourceW, sourceH;
            if (ann.type === 'bbox') {
                sourceX = ann.x; sourceY = ann.y;
                sourceW = ann.width; sourceH = ann.height;
            } else if (ann.type === 'polygon') {
                const xs = ann.points.map(p => p.x);
                const ys = ann.points.map(p => p.y);
                sourceX = Math.min(...xs); sourceY = Math.min(...ys);
                sourceW = Math.max(...xs) - sourceX;
                sourceH = Math.max(...ys) - sourceY;
            } else {
                throw new Error('Unsupported annotation type');
            }

            const response = await fetch('/api/extract-split', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: imageData,
                    sourceX, sourceY, sourceW, sourceH,
                    imageW: currentImage.width,
                    imageH: currentImage.height,
                    mode: mode
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Split failed');
            }

            const { layouts } = await response.json();
            if (!layouts || layouts.length === 0) {
                throw new Error('MinerU returned no layouts');
            }

            // Replace source annotation with N new bbox annotations
            const srcIdx = annotations.indexOf(ann);
            annotations.splice(srcIdx, 1);

            // Insert new annotations at same position
            const baseRO = (ann.reading_order ?? annotations.length);
            layouts.forEach((l, i) => {
                annotations.splice(srcIdx + i, 0, {
                    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                    type: 'bbox',
                    label: l.label,
                    x: l.x, y: l.y,
                    width: l.width, height: l.height,
                    content: l.content || '',
                    reading_order: baseRO + i
                });
            });

            if (selectedAnnotation === ann) selectedAnnotation = null;
            renderAnnotationsList();
            render();
            debouncedSave();

            closeModal();
            alert(`✅ ${isExtract ? 'Extracted & Split' : 'Split'} into ${layouts.length} layout(s)!`);

        } catch (error) {
            alert((isExtract ? 'Extraction' : 'Split') + ' Error: ' + error.message);
        } finally {
            targetBtn.disabled = false;
            targetBtn.innerHTML = originalText;
            onModelChange(); // Restore text
        }
    };

    const extractHandler = async () => {
        if (!extractBtn || !modelSelect) return;
        const model = modelSelect.value;

        if (model === 'mineru_2_5') {
            await splitHandler('extract');
            return;
        }

        const originalText = extractBtn.innerHTML;
        extractBtn.disabled = true;
        extractBtn.innerHTML = `<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4V20M4 12H20" stroke-linecap="round"/></svg> Extracting...`;

        try {
            const imageData = cropImageFromCanvas(ann);
            const response = await fetch('/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: imageData,
                    label: ann.label,
                    model: model
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Extraction failed');
            }

            const data = await response.json();

            // Update Editor
            if (ann.label === 'table') {
                const editor = container.querySelector('.editor-table');
                if (editor) editor.innerHTML = data.content;
            } else {
                const editor = container.querySelector('textarea');
                if (editor) editor.value = data.content;
            }

        } catch (error) {
            alert('Extraction Error: ' + error.message);
        } finally {
            extractBtn.disabled = false;
            extractBtn.innerHTML = originalText;
            onModelChange();
        }
    };

    // Wait, assigned at end of function


    // 6. Close/Cancel Handlers
    const closeModal = () => {
        modal.style.display = 'none';
        saveBtn.onclick = null;
        cancelBtn.onclick = null;
        closeBtn.onclick = null;
        if (prevBtn) prevBtn.onclick = null;
        if (nextBtn) nextBtn.onclick = null;
        if (extractBtn) extractBtn.onclick = null;
        if (splitBtn) splitBtn.onclick = null;
        if (modelSelect) modelSelect.removeEventListener('change', onModelChange);
    };

    // Helper: read content from the active editor widget
    const getCurrentContent = () => {
        const lbl = (ann.label || '').toLowerCase().trim();
        if (lbl === 'table') {
            const ed = container.querySelector('.editor-table');
            return ed ? ed.innerHTML : ann.content;
        } else if (['formula', 'equation', 'equation_block'].includes(lbl)) {
            const mf = container.querySelector('math-field');
            return mf ? mf.value : ann.content;
        } else {
            const ta = container.querySelector('textarea');
            return ta ? ta.value : ann.content;
        }
    };

    // 7. Prev / Next Navigation
    const navigateTo = (targetAnn) => {
        // Auto-save current content before navigating
        ann.content = getCurrentContent();
        render();
        renderAnnotationsList();
        closeModal();
        showContentEditor(targetAnn);
    };

    if (prevBtn) {
        prevBtn.onclick = () => {
            const idx = annotations.indexOf(ann);
            if (idx > 0) navigateTo(annotations[idx - 1]);
        };
    }
    if (nextBtn) {
        nextBtn.onclick = () => {
            const idx = annotations.indexOf(ann);
            if (idx < annotations.length - 1) navigateTo(annotations[idx + 1]);
        };
    }

    saveBtn.onclick = saveHandler;
    cancelBtn.onclick = closeModal;
    closeBtn.onclick = closeModal;
    if (extractBtn) extractBtn.onclick = extractHandler;
    if (splitBtn) splitBtn.onclick = () => splitHandler('layout');

    // Show Modal
    modal.style.display = 'flex';
}

function mergeSelectedAnnotations() {
    if (selectedAnnotations.size < 2) return;

    // 1. Calculate encompassing bbox and unique labels
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    let minRO = Infinity;
    const labels = new Set();

    selectedAnnotations.forEach(ann => {
        if (ann.label) labels.add(ann.label);

        // Track min reading order
        if (ann.reading_order !== undefined && ann.reading_order !== null) {
            minRO = Math.min(minRO, ann.reading_order);
        }

        // Calculate bounds based on type
        if (ann.type === 'bbox' || ann.type === 'keypoint') {
            minX = Math.min(minX, ann.x);
            minY = Math.min(minY, ann.y);
            maxX = Math.max(maxX, ann.x + (ann.width || 0));
            maxY = Math.max(maxY, ann.y + (ann.height || 0));
        } else if (ann.type === 'polygon' && ann.points) {
            ann.points.forEach(p => {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            });
        }
    });

    // Fallback for reading order if none found
    if (minRO === Infinity) minRO = annotations.length;

    const performMerge = (label) => {
        saveUndoState();

        // Create new merged annotation
        const mergedAnn = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            type: 'bbox',
            label: label,
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            content: '',
            reading_order: minRO,
            color: getLabelColor(label),
            imageWidth: currentImage.width,
            imageHeight: currentImage.height
        };

        // Remove originals
        const targets = Array.from(selectedAnnotations);
        targets.forEach(ann => {
            const idx = annotations.indexOf(ann);
            if (idx > -1) annotations.splice(idx, 1);
        });

        // Insert new merged box
        annotations.push(mergedAnn);

        // Re-index reading orders to be sequential
        annotations.sort((a, b) => (a.reading_order ?? 9999) - (b.reading_order ?? 9999));
        annotations.forEach((a, i) => a.reading_order = i);

        // Clear multi-selection and select the new one
        selectedAnnotations.clear();
        selectAnnotation(mergedAnn);

        render();
        renderAnnotationsList();
        updateToolbarState();
        saveAnnotations();
    };

    // 2. Decide whether to show modal
    if (labels.size === 1) {
        // All share same label, merge immediately
        performMerge([...labels][0]);
    } else {
        // Conflicting labels or no labels, show modal
        showLabelModal(performMerge, '', minRO);
    }
}


