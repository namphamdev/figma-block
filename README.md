# Block Structure Copier - Figma Plugin

A Figma plugin that extracts and copies the complete structure of selected blocks/frames including:

- **Block hierarchy** - Parent-child relationships
- **Padding** - Top, Right, Bottom, Left values
- **Layout properties** - Auto-layout mode, gap, alignment
- **SVG Icons** - Automatically detects and exports icons as SVG
- **Visual properties** - Corner radius, size

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the plugin:
   ```bash
   npm run build
   ```

3. In Figma Desktop:
   - Go to Plugins → Development → Import plugin from manifest
   - Select the `manifest.json` file from this directory

## Usage

1. Select a frame/component in Figma
2. Run the plugin: Plugins → Block Structure Copier → Copy Block Structure
3. View the extracted structure in Console or JSON format
4. Click "Copy to Clipboard" to copy the structure

## Output Formats

### Console Output
```
┌─ Button (FRAME)
│  Size: 120 × 40
│  Padding: T:12 R:16 B:12 L:16
│  Layout: HORIZONTAL, Gap: 8
│  Align: CENTER / CENTER
│  Children (2):
    ┌─ Icon (INSTANCE)
    │  Size: 16 × 16
    │  🎨 ICON (SVG available)
    └──
    ┌─ Label (TEXT)
    │  Size: 60 × 16
    └──
└──
```

### JSON Output
```json
{
  "name": "Button",
  "type": "FRAME",
  "size": { "width": 120, "height": 40 },
  "padding": { "top": 12, "right": 16, "bottom": 12, "left": 16 },
  "layout": {
    "mode": "HORIZONTAL",
    "gap": 8,
    "mainAxisAlign": "CENTER",
    "crossAxisAlign": "CENTER"
  },
  "children": [
    {
      "name": "Icon",
      "type": "INSTANCE",
      "isIcon": true,
      "svg": "<svg>...</svg>"
    }
  ]
}
```

## Development

Watch mode for development:
```bash
npm run watch
```
