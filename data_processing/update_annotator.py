
import os

file_path = "/data/ducbm3/DocumentOCR/public/js/annotator.js"

with open(file_path, 'r') as f:
    lines = f.readlines()

new_lines = []
skip = False
target_start = "} else if (['formula', 'equation', 'equation_block'].includes((currentLabel || '').toLowerCase().trim())) {"
target_end = "} else {"
inserted = False

mathlive_block = """        } else if (['formula', 'equation', 'equation_block'].includes((currentLabel || '').toLowerCase().trim())) {
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
"""

found_start = False

for line in lines:
    stripped = line.strip()
    # Check for start
    if target_start in line:
        new_lines.append(mathlive_block)
        skip = True
        found_start = True
        continue
    
    if skip:
        # Check for end
        if line.strip() == "} else {":
            new_lines.append(line) # Keep } else {
            skip = False
        continue
        
    new_lines.append(line)

if found_start:
    with open(file_path, 'w') as f:
        f.writelines(new_lines)
    print("Successfully updated annotator.js")
else:
    print("Could not find target block in annotator.js")
