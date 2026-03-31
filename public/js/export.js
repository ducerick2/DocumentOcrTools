/**
 * Export Dataset Module
 * Handles the 7-step export workflow
 */

(function () {
    // State management
    let state = {
        currentStep: 1,
        format: null, // labelme, yolo, coco
        selectedDatasetId: null,
        selectedDataset: null,
        labels: [],
        mapping: {}, // original -> new
        mergeRules: [], // [{fromA, fromB, to}]
        targetPath: '',
        copyImages: true
    };

    // UI Elements
    const modal = document.getElementById('exportWizardModal');
    const closeBtn = document.getElementById('closeExportWizard');
    const cancelBtn = document.getElementById('cancelExportWizard');
    const nextBtn = document.getElementById('wizardNextBtn');
    const backBtn = document.getElementById('wizardBackBtn');
    const finishBtn = document.getElementById('startExportFinalBtn');
    const formatLabel = document.getElementById('exportFormatLabel');
    const datasetSelect = document.getElementById('exportDatasetSelect');

    // Folder Picker State
    let folderPickerState = {
        currentPath: '/data/ducbm3/DocumentOCR/dataset_public',
        selectedPath: ''
    };

    // UI Elements for Folder Picker
    const folderPickerModal = document.getElementById('folderPickerModal');
    const folderBrowserList = document.getElementById('folderBrowserList');
    const folderCurrentPathLabel = document.getElementById('folderCurrentPath');
    const folderParentBtn = document.getElementById('folderParentDirBtn');
    const closeFolderBtn = document.getElementById('closeFolderPicker');
    const cancelFolderBtn = document.getElementById('cancelFolderPicker');
    const confirmFolderBtn = document.getElementById('confirmFolderPicker');
    const browseBtn = document.getElementById('browseExportPathBtn');
    const exportPathInput = document.getElementById('exportPath');
    const newFolderInput = document.getElementById('newFolderNameInput');

    // Initialize module
    function init() {
        // Attach to format buttons in Export View
        document.querySelectorAll('.start-export-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const format = btn.getAttribute('data-format');
                openWizard(format);
            });
        });

        // Navigation
        nextBtn.addEventListener('click', nextStep);
        backBtn.addEventListener('click', prevStep);
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        finishBtn.addEventListener('click', startExport);

        // Add merge rule
        document.getElementById('addMergeRuleBtn').addEventListener('click', addMergeRuleRow);

        // Folder Picker events
        if (browseBtn) {
            browseBtn.addEventListener('click', () => {
                folderPickerModal.style.display = 'flex';
                browseFolders(folderPickerState.currentPath);
            });
        }

        closeFolderBtn.onclick = () => folderPickerModal.style.display = 'none';
        cancelFolderBtn.onclick = () => folderPickerModal.style.display = 'none';
        folderParentBtn.onclick = () => {
            const parts = folderPickerState.currentPath.replace(/\/+$/, '').split('/');
            parts.pop();
            const parentPath = parts.join('/') || '/';
            browseFolders(parentPath);
        };

        confirmFolderBtn.onclick = () => {
            let finalPath = folderPickerState.currentPath;
            const newName = newFolderInput.value.trim();
            if (newName) {
                finalPath = finalPath.replace(/\/+$/, '') + '/' + newName;
            }
            exportPathInput.value = finalPath;
            folderPickerModal.style.display = 'none';
            // Enable start button if path is set in step 6
            if (state.currentStep === 6) {
                finishBtn.disabled = !finalPath;
            }
        };
    }

    async function browseFolders(path) {
        try {
            const response = await fetch('/api/browse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: path })
            });
            const data = await response.json();
            folderPickerState.currentPath = data.currentPath;
            folderCurrentPathLabel.textContent = data.currentPath;

            folderBrowserList.innerHTML = '';
            // Only show directories
            data.items.filter(item => item.isDirectory).forEach(item => {
                const div = document.createElement('div');
                div.className = 'browser-item directory';
                div.innerHTML = `
                    <div class="browser-item-icon directory">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-8l-2-2H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="2"/></svg>
                    </div>
                    <div class="browser-item-info">
                        <div class="browser-item-name">${item.name}</div>
                        <div class="browser-item-meta">Folder</div>
                    </div>
                `;
                div.onclick = () => browseFolders(item.path);
                folderBrowserList.appendChild(div);
            });
        } catch (error) {
            console.error('Failed to browse folders:', error);
        }
    }

    function openWizard(format) {
        state.format = format;
        state.currentStep = 1;
        formatLabel.textContent = `(${format.toUpperCase()})`;

        resetWizard();
        loadDatasets();

        modal.style.display = 'flex';
        updateStepUI();
    }

    function closeModal() {
        modal.style.display = 'none';
        resetWizard();
    }

    function resetWizard() {
        state.currentStep = 1;
        state.selectedDatasetId = null;
        state.selectedDataset = null;
        state.mapping = {};
        state.mergeRules = [];
        state.targetPath = '';

        document.getElementById('labelMappingTable').innerHTML = '';
        document.getElementById('mergeRulesContainer').innerHTML = '';
        document.getElementById('exportProgressContainer').style.display = 'none';
        finishBtn.style.display = 'none';
        nextBtn.style.display = 'inline-block';
        nextBtn.disabled = true;
    }

    async function loadDatasets() {
        try {
            const response = await fetch('/api/datasets');
            const datasets = await response.json();

            datasetSelect.innerHTML = '';
            datasets.forEach(ds => {
                const option = document.createElement('option');
                option.value = ds.id;
                option.textContent = `${ds.name} (${ds.annotationType})`;
                datasetSelect.appendChild(option);
            });

            // Set initial value if available
            if (datasets.length > 0) {
                state.selectedDatasetId = datasets[0].id;
                datasetSelect.value = state.selectedDatasetId;
                nextBtn.disabled = false;
            }

            datasetSelect.onchange = () => {
                state.selectedDatasetId = datasetSelect.value;
                nextBtn.disabled = !state.selectedDatasetId;
            };
        } catch (error) {
            console.error('Failed to load datasets:', error);
        }
    }

    function nextStep() {
        if (state.currentStep === 1 && !state.selectedDatasetId) return;

        if (state.currentStep < 6) {
            state.currentStep++;
            onStepEnter(state.currentStep);
            updateStepUI();
        }
    }

    function prevStep() {
        if (state.currentStep > 1) {
            state.currentStep--;
            updateStepUI();
        }
    }

    async function onStepEnter(step) {
        switch (step) {
            case 2: // Stats
                await loadStats();
                break;
            case 3: // Mapping
                buildMappingUI();
                break;
            case 4: // Merging
                // Pre-populated by user actions
                break;
            case 5: // Path
                // Initial focus
                setTimeout(() => document.getElementById('exportPath').focus(), 100);
                break;
            case 6: // Finalize
                buildSummary();
                break;
        }
    }

    async function loadStats() {
        // Show loading state
        const labelsContainer = document.getElementById('exportStatLabels');
        labelsContainer.innerHTML = '<div class="spinner-sm"></div> <span style="margin-left:8px; color:var(--text-secondary);">Loading statistics...</span>';

        const imagesVal = document.getElementById('exportStatImages');
        const annotsVal = document.getElementById('exportStatAnnots');
        imagesVal.textContent = '...';
        annotsVal.textContent = '...';

        const nextBtn = document.getElementById('wizardNextBtn');
        if (nextBtn) nextBtn.disabled = true;

        try {
            // Fetch images for this dataset to count them
            const imgResponse = await fetch(`/api/datasets/${state.selectedDatasetId}/images`);
            const images = await imgResponse.json();

            // Get full details
            const dsResponse = await fetch(`/api/datasets/${state.selectedDatasetId}`);
            state.selectedDataset = await dsResponse.json();

            // NEW: Fetch unique labels dynamically from annotations
            const labelsResponse = await fetch(`/api/datasets/${state.selectedDatasetId}/labels`);
            state.labels = await labelsResponse.json();

            imagesVal.textContent = images.length;

            // Fetch actual annotation count from the dataset object
            annotsVal.textContent = state.selectedDataset.annotatedCount || 0;

            labelsContainer.innerHTML = '';

            if (state.labels.length === 0) {
                labelsContainer.innerHTML = '<span style="color: var(--text-secondary); font-style: italic;">No annotations found</span>';
            } else {
                state.labels.forEach(lbl => {
                    const span = document.createElement('span');
                    span.className = 'badge';
                    span.style.background = 'var(--bg-secondary)';
                    span.style.color = 'var(--text-primary)';
                    span.style.border = '1px solid var(--border-color)';
                    span.textContent = lbl;
                    labelsContainer.appendChild(span);
                });
            }

            if (nextBtn) nextBtn.disabled = false;
        } catch (error) {
            console.error('Error loading stats:', error);
            labelsContainer.innerHTML = `<span style="color: var(--danger-color);">Error loading statistics: ${error.message}</span>`;
            if (nextBtn) nextBtn.disabled = false;
        }
    }

    function buildMappingUI() {
        const table = document.getElementById('labelMappingTable');
        table.innerHTML = '';

        state.labels.forEach(lbl => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding: 10px; border-bottom: 1px solid var(--border-color);">${lbl}</td>
                <td style="padding: 10px; border-bottom: 1px solid var(--border-color);">
                    <input type="text" class="form-input label-map-input" data-original="${lbl}" placeholder="${lbl}">
                </td>
            `;
            table.appendChild(tr);
        });
    }

    function addMergeRuleRow() {
        const container = document.getElementById('mergeRulesContainer');
        const div = document.createElement('div');
        div.className = 'merge-rule-row';
        div.style.display = 'flex';
        div.style.gap = '10px';
        div.style.alignItems = 'center';
        div.style.marginBottom = '10px';

        const options = state.labels.map(l => `<option value="${l}">${l}</option>`).join('');

        div.innerHTML = `
            <select class="form-select merge-a" style="flex: 1;">${options}</select>
            <span>+</span>
            <select class="form-select merge-b" style="flex: 1;">${options}</select>
            <span>→</span>
            <input type="text" class="form-input merge-to" placeholder="Merged Name" style="flex: 1;">
            <button class="btn btn-sm btn-danger remove-merge-btn">&times;</button>
        `;

        div.querySelector('.remove-merge-btn').onclick = () => div.remove();
        container.appendChild(div);
    }

    function buildSummary() {
        // Collect mapping data
        state.mapping = {};
        document.querySelectorAll('.label-map-input').forEach(input => {
            if (input.value.trim()) {
                state.mapping[input.getAttribute('data-original')] = input.value.trim();
            }
        });

        // Collect merge rules
        state.mergeRules = [];
        document.querySelectorAll('.merge-rule-row').forEach(row => {
            const a = row.querySelector('.merge-a').value;
            const b = row.querySelector('.merge-b').value;
            const to = row.querySelector('.merge-to').value.trim();
            if (to) {
                state.mergeRules.push({ fromA: a, fromB: b, to: to });
            }
        });

        state.targetPath = document.getElementById('exportPath').value.trim();
        state.copyImages = document.getElementById('copyImagesToggle').checked;

        const summary = document.getElementById('exportSummary');
        summary.innerHTML = `
            <div style="margin-bottom: 10px;"><strong>Dataset:</strong> ${state.selectedDataset.name}</div>
            <div style="margin-bottom: 10px;"><strong>Format:</strong> ${state.format.toUpperCase()}</div>
            <div style="margin-bottom: 10px;"><strong>Destination:</strong> ${state.targetPath || 'Not set'}</div>
            <div style="margin-bottom: 10px;"><strong>Mappings:</strong> ${Object.keys(state.mapping).length} labels renamed</div>
            <div style="margin-bottom: 10px;"><strong>Merge Rules:</strong> ${state.mergeRules.length} pairs configured</div>
            <div style="margin-bottom: 10px;"><strong>Images:</strong> ${state.copyImages ? 'Will be copied' : 'References only'}</div>
        `;

        finishBtn.style.display = 'inline-block';
        nextBtn.style.display = 'none';
        finishBtn.disabled = !state.targetPath;
    }

    function updateStepUI() {
        // Update steppers
        document.querySelectorAll('.wizard-stepper .step').forEach(stepEl => {
            const stepNum = parseInt(stepEl.getAttribute('data-step'));
            stepEl.classList.toggle('active', stepNum === state.currentStep);
            stepEl.classList.toggle('completed', stepNum < state.currentStep);
        });

        // Update content panels
        document.querySelectorAll('.wizard-step-content').forEach((panel, index) => {
            panel.style.display = (index + 1 === state.currentStep) ? 'block' : 'none';
        });

        // Update buttons
        backBtn.disabled = state.currentStep === 1;
        if (state.currentStep < 6) {
            nextBtn.style.display = 'inline-block';
            finishBtn.style.display = 'none';
        }
    }

    async function startExport() {
        finishBtn.disabled = true;
        backBtn.disabled = true;

        const progressContainer = document.getElementById('exportProgressContainer');
        const progressBar = document.getElementById('exportProgressBar');
        const progressPercent = document.getElementById('exportProgressPercent');
        const progressStatus = document.getElementById('exportProgressStatus');

        progressContainer.style.display = 'block';

        try {
            const payload = {
                datasetId: state.selectedDatasetId,
                format: state.format,
                mapping: state.mapping,
                mergeRules: state.mergeRules,
                targetPath: state.targetPath,
                copyImages: state.copyImages
            };

            const response = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(await response.text());

            // Mocking progress for UX since the backend operation might be long
            let progress = 0;
            const interval = setInterval(() => {
                progress += Math.random() * 15;
                if (progress >= 95) {
                    clearInterval(interval);
                    progress = 100;
                    progressBar.style.width = '100%';
                    progressPercent.textContent = '100%';
                    progressStatus.textContent = 'Export completed successfully!';
                    setTimeout(() => {
                        alert('Export completed!');
                        closeModal();
                    }, 500);
                } else {
                    progressBar.style.width = `${progress}%`;
                    progressPercent.textContent = `${Math.round(progress)}%`;
                }
            }, 300);

        } catch (error) {
            progressStatus.textContent = 'Error: ' + error.message;
            progressStatus.style.color = 'var(--danger-color)';
            finishBtn.disabled = false;
        }
    }

    // Export to window
    window.initExportModule = init;

    // Run when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
