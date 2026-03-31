# Dataset Manager - Document OCR

A comprehensive web application for managing, annotating, and organizing datasets for document OCR training pipelines.

## Features

- **Dataset Management**: Create, organize, and manage multiple datasets
- **Image Upload**: Drag-and-drop or browse to upload images
- **Annotation Tools**: 
  - Bounding boxes for text regions
  - Polygons for irregular shapes
  - Keypoints for document corners
- **Label Management**: Define custom labels for your annotation tasks
- **Export Formats**: Export annotations in COCO, YOLO, or JSON formats
- **Modern UI**: Dark theme with smooth animations and responsive design
- **Canvas Controls**: Zoom, pan, and navigate large images easily

## Installation

1. **Install dependencies**:
```bash
cd /data/ducbm3/DocumentOCR
npm install
```

2. **Start the server**:
```bash
npm start
```

3. **Open in browser**:
Navigate to `http://localhost:3001`

## Usage

### Creating a Dataset

1. Click "Create Dataset" button
2. Enter dataset name, description, and labels (comma-separated)
3. Select annotation type (Bounding Box, Polygon, Keypoint, or Mixed)
4. Click "Create Dataset"

### Uploading Images

1. Click on a dataset to open it
2. Click "Upload Images" button
3. Drag and drop images or click to browse
4. Click "Upload" to add images to the dataset

### Annotating Images

1. Select an image from the left panel
2. Choose a label from the dropdown
3. Select an annotation tool:
   - **Select**: Click and drag to pan, click annotations to select
   - **Bounding Box**: Click and drag to draw rectangles
   - **Polygon**: Click to add points, right-click or double-click to finish
   - **Keypoint**: Click to place points
4. Use zoom controls to navigate large images
5. Click "Save" to save annotations

### Keyboard Shortcuts

- `Ctrl+S`: Save annotations
- `Delete`: Delete selected annotation
- `Escape`: Deselect annotation / Cancel polygon drawing
- `Mouse Wheel`: Zoom in/out

### Exporting Data

1. Click on "Export" in the navigation
2. Choose export format:
   - **COCO Format**: Standard format for object detection
   - **YOLO Format**: Format for YOLO training
   - **JSON Format**: Raw annotations
3. Click the export button to download

## Project Structure

```
DocumentOCR/
├── server.js              # Express.js backend server
├── package.json           # Node.js dependencies
├── data/                  # Data storage
│   ├── datasets.json      # Dataset metadata
│   ├── uploads/           # Uploaded images
│   └── annotations/       # Annotation data
└── public/                # Frontend files
    ├── index.html         # Main HTML
    ├── css/
    │   └── styles.css     # Styles and design system
    └── js/
        ├── app.js         # Main application logic
        └── annotator.js   # Canvas annotation tool
```

## API Endpoints

### Datasets
- `GET /api/datasets` - Get all datasets
- `GET /api/datasets/:id` - Get single dataset
- `POST /api/datasets` - Create new dataset
- `PUT /api/datasets/:id` - Update dataset
- `DELETE /api/datasets/:id` - Delete dataset

### Images
- `GET /api/datasets/:id/images` - Get all images in dataset
- `POST /api/datasets/:id/images` - Upload images
- `GET /api/datasets/:id/images/:filename` - Get image file
- `DELETE /api/datasets/:id/images/:filename` - Delete image

### Annotations
- `GET /api/datasets/:id/annotations` - Get all annotations
- `GET /api/datasets/:id/annotations/:imageId` - Get annotations for image
- `POST /api/datasets/:id/annotations` - Save annotations

### Export
- `GET /api/datasets/:id/export/:format` - Export annotations (format: coco, yolo, json)

## Data Formats

### Bounding Box Annotation
```json
{
  "type": "bbox",
  "label": "text",
  "x": 100,
  "y": 150,
  "width": 200,
  "height": 50,
  "imageWidth": 1920,
  "imageHeight": 1080
}
```

### Polygon Annotation
```json
{
  "type": "polygon",
  "label": "logo",
  "points": [
    {"x": 100, "y": 100},
    {"x": 200, "y": 100},
    {"x": 150, "y": 200}
  ],
  "imageWidth": 1920,
  "imageHeight": 1080
}
```

### Keypoint Annotation
```json
{
  "type": "keypoint",
  "label": "corner",
  "x": 100,
  "y": 150,
  "imageWidth": 1920,
  "imageHeight": 1080
}
```

## Technologies Used

- **Backend**: Node.js, Express.js, Multer
- **Frontend**: Vanilla JavaScript, HTML5 Canvas
- **Storage**: File-based JSON storage
- **Design**: Modern CSS with dark theme and gradients

## License

MIT
