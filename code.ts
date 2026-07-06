// Block Structure Copier - Figma Plugin
// Extracts block structure, children, SVG icons, and padding from selected elements

// Debug log collector - accumulated during extraction, sent with structure message
let debugLogs: string[] = [];
function debugLog(msg: string) {
  debugLogs.push(msg);
}

// Round numeric values to avoid floating-point precision issues
// For pixel values, round to nearest integer if very close, otherwise keep 2 decimal places
function roundValue(value: number): number {
  // If the value is very close to an integer (within 0.001), round to integer
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.001) {
    return rounded;
  }
  // Otherwise, round to 2 decimal places
  return Math.round(value * 100) / 100;
}

interface BlockStructure {
  id: string;
  name: string;
  type: string;
  padding?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  itemSpacing?: number;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  width: number;
  height: number;
  fills?: readonly Paint[] | typeof figma.mixed;
  strokes?: readonly Paint[];
  strokeWeight?: number | typeof figma.mixed;
  opacity?: number;
  cornerRadius?: number | typeof figma.mixed;
  effects?: readonly Effect[];
  children?: BlockStructure[];
  svgContent?: string;
  isIcon?: boolean;
  // Text properties
  textContent?: string;
  fontSize?: number | typeof figma.mixed;
  fontWeight?: number | typeof figma.mixed;
  fontFamily?: string | typeof figma.mixed;
  lineHeight?: { value?: number; unit: string } | typeof figma.mixed;
  letterSpacing?: { value?: number; unit: string } | typeof figma.mixed;
  textAlignHorizontal?: string;
  textColor?: string;
}

// Extract padding from auto-layout frames
function extractPadding(node: SceneNode): BlockStructure['padding'] | undefined {
  if ('paddingTop' in node) {
    return {
      top: roundValue(node.paddingTop ?? 0),
      right: roundValue(node.paddingRight ?? 0),
      bottom: roundValue(node.paddingBottom ?? 0),
      left: roundValue(node.paddingLeft ?? 0)
    };
  }
  return undefined;
}

// Check if node is likely an icon (small vector/frame with vectors)
// Checks up to 3 levels deep to handle nested GROUP structures common in icon libraries
function isLikelyIcon(node: SceneNode): boolean {
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
    return true;
  }
  if ((node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'GROUP') && node.width <= 64 && node.height <= 64) {
    // Check up to 3 levels deep to find vector content
    // This handles cases like: INSTANCE > GROUP > BOOLEAN_OPERATION
    if ('children' in node) {
      for (const child of node.children) {
        if (child.type === 'VECTOR' || child.type === 'BOOLEAN_OPERATION') {
          return true;
        }
        // Check grandchildren (level 2)
        if ('children' in child) {
          for (const grandchild of child.children) {
            if (grandchild.type === 'VECTOR' || grandchild.type === 'BOOLEAN_OPERATION') {
              return true;
            }
            // Check great-grandchildren (level 3)
            if ('children' in grandchild) {
              for (const greatGrandchild of grandchild.children) {
                if (greatGrandchild.type === 'VECTOR' || greatGrandchild.type === 'BOOLEAN_OPERATION') {
                  return true;
                }
              }
            }
          }
        }
      }
    }
  }
  return false;
}

// Check if node has visible content that can be exported
function hasVisibleContent(node: SceneNode): boolean {
  // Check if node itself is visible
  if ('visible' in node && !node.visible) {
    return false;
  }
  
  // Check opacity
  if ('opacity' in node && node.opacity === 0) {
    return false;
  }
  
  // For nodes with children, check if at least one child is visible
  if ('children' in node) {
    if (node.children.length === 0) {
      return false;
    }
    // Check if any child has visible content
    return node.children.some(child => hasVisibleContent(child));
  }
  
  // For leaf nodes (vectors, etc.), check if they have visible fills or strokes
  if ('fills' in node || 'strokes' in node) {
    const hasFills = 'fills' in node && Array.isArray(node.fills) && node.fills.length > 0 && node.fills.some((f: Paint) => f.visible !== false);
    const hasStrokes = 'strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0 && node.strokes.some((s: Paint) => s.visible !== false);
    return hasFills || hasStrokes;
  }
  
  return true;
}

// Pretty-print SVG with proper indentation
function prettifySvg(svg: string): string {
  // Remove existing whitespace between tags
  let formatted = svg.replace(/>\s+</g, '><').trim();
  
  let result = '';
  let indent = 0;
  const indentStr = '  ';
  
  // Split by tags while keeping the tags
  const tokens = formatted.split(/(<[^>]+>)/g).filter(t => t.trim());
  
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    
    if (trimmed.startsWith('</')) {
      // Closing tag - decrease indent first
      indent = Math.max(0, indent - 1);
      result += indentStr.repeat(indent) + trimmed + '\n';
    } else if (trimmed.startsWith('<') && trimmed.endsWith('/>')) {
      // Self-closing tag
      result += indentStr.repeat(indent) + trimmed + '\n';
    } else if (trimmed.startsWith('<?') || trimmed.startsWith('<!')) {
      // XML declaration or doctype
      result += trimmed + '\n';
    } else if (trimmed.startsWith('<')) {
      // Opening tag
      result += indentStr.repeat(indent) + trimmed + '\n';
      indent++;
    } else {
      // Text content
      result += indentStr.repeat(indent) + trimmed + '\n';
    }
  }
  
  return result.trim();
}

// Export node as SVG
interface ExportedImagePayload {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  format: 'PNG' | 'JPG';
  mimeType: string;
  fileName: string;
  dataBase64: string;
  source: 'node' | 'fill';
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'image';
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  if (typeof btoa !== 'undefined') {
    return btoa(binary);
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    result += i + 2 < bytes.length ? chars[c & 63] : '=';
  }
  return result;
}

interface ImageFillRef {
  node: SceneNode;
  paint: ImagePaint;
  fillIndex: number;
}

function getImageFillsFromNode(node: SceneNode): ImageFillRef[] {
  const refs: ImageFillRef[] = [];
  if (!('fills' in node) || node.fills === figma.mixed || !Array.isArray(node.fills)) {
    return refs;
  }
  node.fills.forEach((fill, fillIndex) => {
    if (fill.type === 'IMAGE' && fill.visible !== false && fill.imageHash) {
      refs.push({ node, paint: fill, fillIndex });
    }
  });
  return refs;
}

function collectImageFillRefs(root: SceneNode, out: ImageFillRef[], onProgress?: () => void): void {
  if ('visible' in root && root.visible === false) {
    return;
  }
  if ('opacity' in root && root.opacity === 0) {
    return;
  }
  if (onProgress) {
    onProgress();
  }

  out.push(...getImageFillsFromNode(root));

  if ('children' in root) {
    for (const child of root.children) {
      collectImageFillRefs(child, out, onProgress);
    }
  }
}

function detectImageMime(bytes: Uint8Array): { mimeType: string; ext: string } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  return { mimeType: 'image/png', ext: 'png' };
}

async function loadNodeIfNeeded(node: SceneNode): Promise<void> {
  if ('loadAsync' in node && typeof (node as { loadAsync?: () => Promise<void> }).loadAsync === 'function') {
    await (node as { loadAsync: () => Promise<void> }).loadAsync();
  }
}

async function exportNodeAsRaster(
  node: SceneNode,
  index: number,
  fillIndex: number
): Promise<ExportedImagePayload | undefined> {
  if (!('exportAsync' in node)) {
    return undefined;
  }
  try {
    await loadNodeIfNeeded(node);
    const width = roundValue(node.width);
    const height = roundValue(node.height);
    if (width <= 0 || height <= 0) {
      return undefined;
    }
    const maxSide = Math.max(width, height);
    let constraint: ExportSettingsConstraints | undefined;
    if (maxSide > 2048) {
      constraint = { type: 'WIDTH', value: 2048 };
    } else if (maxSide > 1024) {
      constraint = { type: 'SCALE', value: 1 };
    } else {
      constraint = { type: 'SCALE', value: 2 };
    }
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint
    });
    const baseName = sanitizeFileName(node.name);
    const fileName = `${baseName}${fillIndex > 0 ? `-fill-${fillIndex + 1}` : ''}-${index + 1}.png`;
    return {
      id: `${node.id}:${fillIndex}`,
      name: node.name,
      type: node.type,
      width,
      height,
      format: 'PNG',
      mimeType: 'image/png',
      fileName,
      dataBase64: uint8ArrayToBase64(bytes),
      source: 'node'
    };
  } catch (e) {
    debugLog(`[IMAGE] exportAsync failed for "${node.name}": ${String(e)}`);
    return undefined;
  }
}

async function exportImageFromHash(
  ref: ImageFillRef,
  index: number
): Promise<ExportedImagePayload | undefined> {
  const { node, paint, fillIndex } = ref;
  const hash = paint.imageHash;
  if (!hash) {
    return undefined;
  }
  try {
    await loadNodeIfNeeded(node);
    const image = figma.getImageByHash(hash);
    if (!image) {
      debugLog(`[IMAGE] getImageByHash returned null for "${node.name}" hash=${hash}`);
      return await exportNodeAsRaster(node, index, fillIndex);
    }
    const bytes = await image.getBytesAsync();
    if (!bytes || bytes.length === 0) {
      return await exportNodeAsRaster(node, index, fillIndex);
    }
    const { mimeType, ext } = detectImageMime(bytes);
    const baseName = sanitizeFileName(node.name);
    const fileName = `${baseName}${fillIndex > 0 ? `-fill-${fillIndex + 1}` : ''}-${index + 1}.${ext}`;
    const width = roundValue(node.width);
    const height = roundValue(node.height);
    return {
      id: `${node.id}:${fillIndex}:${hash}`,
      name: node.name,
      type: node.type,
      width,
      height,
      format: ext === 'jpg' ? 'JPG' : 'PNG',
      mimeType,
      fileName,
      dataBase64: uint8ArrayToBase64(bytes),
      source: 'fill'
    };
  } catch (e) {
    debugLog(`[IMAGE] getBytesAsync failed for "${node.name}": ${String(e)}`);
    return await exportNodeAsRaster(node, index, fillIndex);
  }
}

async function exportImagesFromRoots(
  roots: readonly SceneNode[],
  onProgress?: () => void
): Promise<ExportedImagePayload[]> {
  const refs: ImageFillRef[] = [];
  for (const root of roots) {
    await loadNodeIfNeeded(root);
    collectImageFillRefs(root, refs, onProgress);
  }

  debugLog(`[IMAGE] found ${refs.length} image fill(s) in selection`);

  const seenKeys = new Set<string>();
  const uniqueRefs: ImageFillRef[] = [];
  for (const ref of refs) {
    const key = `${ref.node.id}:${ref.fillIndex}:${ref.paint.imageHash ?? ''}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueRefs.push(ref);
    }
  }

  const results: ExportedImagePayload[] = [];
  for (let i = 0; i < uniqueRefs.length; i++) {
    const payload = await exportImageFromHash(uniqueRefs[i], i);
    if (payload) {
      results.push(payload);
    }
  }
  debugLog(`[IMAGE] exported ${results.length} image(s)`);
  return results;
}

async function exportAsSvg(node: SceneNode): Promise<string | undefined> {
  try {
    if ('exportAsync' in node) {
      const svgData = await node.exportAsync({ format: 'SVG' });
      // Use TextDecoder for reliable conversion (handles large arrays)
      // Fallback to chunk-based approach if TextDecoder not available
      let svgString: string;
      if (typeof TextDecoder !== 'undefined') {
        svgString = new TextDecoder('utf-8').decode(svgData);
      } else {
        // Chunk-based conversion to avoid stack overflow
        const chunks: string[] = [];
        const chunkSize = 8192;
        for (let i = 0; i < svgData.length; i += chunkSize) {
          const chunk = svgData.slice(i, i + chunkSize);
          chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
        }
        svgString = chunks.join('');
      }
      // Only return if we got valid SVG content
      if (svgString && svgString.includes('<svg')) {
        return prettifySvg(svgString);
      }
    }
  } catch (e) {
    // Log error for debugging (visible in Figma console)
    console.error('SVG export failed for node:', node.name, e);
  }
  return undefined;
}

// Recursively extract block structure
// insideIcon: true when we're inside a node that's already been identified as an icon (to avoid duplicate SVGs)
async function extractBlockStructure(node: SceneNode, depth: number = 0, onProgress?: () => void, insideIcon: boolean = false): Promise<BlockStructure> {
  // Call progress callback
  if (onProgress) onProgress();
  const structure: BlockStructure = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: roundValue(node.width),
    height: roundValue(node.height)
  };

  // Extract padding for auto-layout frames
  structure.padding = extractPadding(node);

  // Extract layout properties
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    structure.layoutMode = node.layoutMode;
    structure.itemSpacing = roundValue(node.itemSpacing);
    structure.primaryAxisAlignItems = node.primaryAxisAlignItems;
    structure.counterAxisAlignItems = node.counterAxisAlignItems;
  }

  // Extract visual properties
  if ('fills' in node) {
    structure.fills = node.fills;
  }
  if ('strokes' in node) {
    structure.strokes = node.strokes;
    if (Array.isArray(node.strokes) && node.strokes.length > 0) {
      const debugStrokes = node.strokes.map((s: any) => ({
        type: s.type,
        color: s.color,
        opacity: s.opacity,
        visible: s.visible,
        keys: Object.keys(s)
      }));
      debugLog(`[EXTRACT] node="${node.name}" strokes=${JSON.stringify(debugStrokes)}`);
    }
  }
  if ('strokeWeight' in node) {
    structure.strokeWeight = node.strokeWeight === figma.mixed ? figma.mixed : roundValue(node.strokeWeight as number);
  }
  if ('opacity' in node && node.opacity !== 1) {
    structure.opacity = roundValue(node.opacity);
  }
  if ('cornerRadius' in node) {
    structure.cornerRadius = node.cornerRadius === figma.mixed ? figma.mixed : roundValue(node.cornerRadius as number);
  }
  if ('effects' in node && Array.isArray(node.effects) && node.effects.length > 0) {
    structure.effects = node.effects;
  }

  // Extract text properties for TEXT nodes
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    structure.textContent = textNode.characters;
    structure.fontSize = textNode.fontSize === figma.mixed ? figma.mixed : roundValue(textNode.fontSize as number);
    structure.fontWeight = textNode.fontWeight;
    structure.letterSpacing = textNode.letterSpacing;
    structure.lineHeight = textNode.lineHeight;
    structure.textAlignHorizontal = textNode.textAlignHorizontal;
    
    // Extract font family
    if (textNode.fontName !== figma.mixed) {
      structure.fontFamily = textNode.fontName.family;
    } else {
      structure.fontFamily = figma.mixed;
    }
    
    // Extract text color from fills
    if (textNode.fills && textNode.fills !== figma.mixed && Array.isArray(textNode.fills)) {
      const solidFill = textNode.fills.find((f): f is SolidPaint => f.type === 'SOLID' && f.visible !== false);
      if (solidFill) {
        const { r, g, b } = solidFill.color;
        const a = solidFill.opacity ?? 1;
        const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
        if (a < 1) {
          structure.textColor = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`;
        } else {
          structure.textColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }
      }
    }
  }

  // Check if it's an icon and export SVG
  // Skip if we're already inside an icon (parent was already exported as SVG)
  const nodeIsIcon = !insideIcon && isLikelyIcon(node);
  if (nodeIsIcon) {
    structure.isIcon = true;
    structure.svgContent = await exportAsSvg(node);
  }

  // Recursively process children (skip hidden ones)
  if ('children' in node) {
    structure.children = [];
    for (const child of node.children) {
      // Skip hidden nodes
      if ('visible' in child && !child.visible) {
        continue;
      }
      // Skip nodes with zero opacity
      if ('opacity' in child && child.opacity === 0) {
        continue;
      }
      // If current node is an icon, pass insideIcon=true to children to prevent duplicate SVG exports
      const childStructure = await extractBlockStructure(child, depth + 1, onProgress, nodeIsIcon || insideIcon);
      structure.children.push(childStructure);
    }
  }

  return structure;
}

// Format structure for console output
function formatForConsole(structure: BlockStructure, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  let output = '';

  output += `${prefix}┌─ ${structure.name} (${structure.type})\n`;
  output += `${prefix}│  Size: ${structure.width} × ${structure.height}\n`;

  if (structure.padding) {
    output += `${prefix}│  Padding: T:${structure.padding.top} R:${structure.padding.right} B:${structure.padding.bottom} L:${structure.padding.left}\n`;
  }

  if (structure.layoutMode) {
    output += `${prefix}│  Layout: ${structure.layoutMode}, Gap: ${structure.itemSpacing}\n`;
    output += `${prefix}│  Align: ${structure.primaryAxisAlignItems} / ${structure.counterAxisAlignItems}\n`;
  }

  if (structure.cornerRadius !== undefined && structure.cornerRadius !== 0) {
    output += `${prefix}│  Border Radius: ${typeof structure.cornerRadius === 'number' ? structure.cornerRadius : 'mixed'}\n`;
  }

  // Show opacity if not 1
  if (structure.opacity !== undefined && structure.opacity !== 1) {
    output += `${prefix}│  Opacity: ${Math.round(structure.opacity * 100)}%\n`;
  }

  // Show fill color
  if (structure.fills && structure.fills !== figma.mixed && Array.isArray(structure.fills)) {
    const solidFill = structure.fills.find((f): f is SolidPaint => f.type === 'SOLID' && f.visible !== false);
    if (solidFill) {
      const { r, g, b } = solidFill.color;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      const fillOpacity = solidFill.opacity !== undefined && solidFill.opacity < 1 ? ` (${Math.round(solidFill.opacity * 100)}%)` : '';
      output += `${prefix}│  Fill: ${hexColor}${fillOpacity}\n`;
    }
  }

  // Show stroke
  if (structure.strokes && Array.isArray(structure.strokes) && structure.strokes.length > 0) {
    const solidStroke = structure.strokes.find((s): s is SolidPaint => s.type === 'SOLID' && s.visible !== false);
    if (solidStroke) {
      const { r, g, b } = solidStroke.color;
      const a = solidStroke.opacity ?? 1;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      const strokeWidth = structure.strokeWeight !== undefined && structure.strokeWeight !== figma.mixed ? structure.strokeWeight : 1;
      const strokeOpacityStr = a < 1 ? `, ${Math.round(a * 100)}%` : '';
      output += `${prefix}│  Stroke: ${hexColor} (${strokeWidth}px${strokeOpacityStr})\n`;
      debugLog(`[STROKE FORMAT] name=${structure.name} keys=${Object.keys(solidStroke).join(',')} opacity=${solidStroke.opacity} color.a=${(solidStroke.color as any).a} color=${JSON.stringify(solidStroke.color)}`);
    }
  }

  // Show text properties
  if (structure.textContent !== undefined) {
    const truncatedText = structure.textContent.length > 50 
      ? structure.textContent.substring(0, 50) + '...' 
      : structure.textContent;
    output += `${prefix}│  Text: "${truncatedText}"\n`;
    
    if (structure.fontSize !== undefined && structure.fontSize !== figma.mixed) {
      output += `${prefix}│  Font Size: ${structure.fontSize}px\n`;
    }
    if (structure.fontFamily !== undefined && structure.fontFamily !== figma.mixed) {
      output += `${prefix}│  Font Family: ${structure.fontFamily}\n`;
    }
    if (structure.fontWeight !== undefined && structure.fontWeight !== figma.mixed) {
      output += `${prefix}│  Font Weight: ${structure.fontWeight}\n`;
    }
    if (structure.lineHeight !== undefined && structure.lineHeight !== figma.mixed) {
      const lh = structure.lineHeight as { value?: number; unit: string };
      if (lh.unit === 'PIXELS' && lh.value !== undefined) {
        output += `${prefix}│  Line Height: ${roundValue(lh.value)}px\n`;
      } else if (lh.unit === 'PERCENT' && lh.value !== undefined) {
        output += `${prefix}│  Line Height: ${roundValue(lh.value)}%\n`;
      } else {
        output += `${prefix}│  Line Height: auto\n`;
      }
    }
    if (structure.textColor) {
      output += `${prefix}│  Text Color: ${structure.textColor}\n`;
    }
    if (structure.textAlignHorizontal) {
      output += `${prefix}│  Text Align: ${structure.textAlignHorizontal}\n`;
    }
  }

  if (structure.isIcon && structure.svgContent) {
    output += `${prefix}│  🎨 ICON:\n`;
    // Include SVG content with proper indentation
    const svgLines = structure.svgContent.split('\n');
    svgLines.forEach(line => {
      output += `${prefix}│    ${line}\n`;
    });
  }

  if (structure.children && structure.children.length > 0) {
    output += `${prefix}│  Children (${structure.children.length}):\n`;
    structure.children.forEach((child, index) => {
      output += formatForConsole(child, indent + 2);
    });
  }

  output += `${prefix}└──\n`;
  return output;
}

// Convert Figma fills to background color string
function fillsToBackground(fills: readonly Paint[] | typeof figma.mixed | undefined): string | undefined {
  if (!fills || fills === figma.mixed || !Array.isArray(fills)) {
    return undefined;
  }
  
  // Find the first visible solid color fill
  const solidFill = fills.find((f): f is SolidPaint => f.type === 'SOLID' && f.visible !== false);
  if (solidFill) {
    const { r, g, b } = solidFill.color;
    const a = solidFill.opacity ?? 1;
    const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
    if (a < 1) {
      return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`;
    }
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  
  // Check for gradient fills
  const gradientFill = fills.find((f): f is GradientPaint => 
    (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_ANGULAR' || f.type === 'GRADIENT_DIAMOND') && f.visible !== false
  );
  if (gradientFill) {
    const stops = gradientFill.gradientStops.map(stop => {
      const { r, g, b } = stop.color;
      const a = stop.color.a ?? 1;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const color = a < 1 
        ? `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`
        : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      return `${color} ${Math.round(stop.position * 100)}%`;
    }).join(', ');
    
    if (gradientFill.type === 'GRADIENT_LINEAR') {
      return `linear-gradient(${stops})`;
    } else if (gradientFill.type === 'GRADIENT_RADIAL') {
      return `radial-gradient(${stops})`;
    }
  }
  
  return undefined;
}

// Generate clean JSON structure
function generateCleanStructure(structure: BlockStructure): object {
  const clean: any = {
    name: structure.name,
    type: structure.type,
    size: { width: structure.width, height: structure.height }
  };

  if (structure.padding && (structure.padding.top || structure.padding.right || structure.padding.bottom || structure.padding.left)) {
    clean.padding = structure.padding;
  }

  if (structure.layoutMode) {
    clean.layout = {
      mode: structure.layoutMode,
      gap: structure.itemSpacing,
      mainAxisAlign: structure.primaryAxisAlignItems,
      crossAxisAlign: structure.counterAxisAlignItems
    };
  }

  // Add background color from fills
  const background = fillsToBackground(structure.fills);
  if (background) {
    clean.background = background;
  }

  // Add opacity if not 1
  if (structure.opacity !== undefined && structure.opacity !== 1) {
    clean.opacity = structure.opacity;
  }

  // Add stroke/border
  if (structure.strokes && Array.isArray(structure.strokes) && structure.strokes.length > 0) {
    const solidStroke = structure.strokes.find((s): s is SolidPaint => s.type === 'SOLID' && s.visible !== false);
    if (solidStroke) {
      const { r, g, b } = solidStroke.color;
      const a = solidStroke.opacity ?? 1;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const strokeColor = a < 1
        ? `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`
        : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      const strokeWidth = structure.strokeWeight !== undefined && structure.strokeWeight !== figma.mixed 
        ? structure.strokeWeight 
        : 1;
      clean.border = {
        color: strokeColor,
        width: strokeWidth
      };
    }
  }

  if (structure.cornerRadius !== undefined && structure.cornerRadius !== 0) {
    // Handle figma.mixed symbol - convert to string for serialization
    clean.borderRadius = structure.cornerRadius === figma.mixed ? 'mixed' : structure.cornerRadius;
  }

  // Add effects/shadows to clean structure
  if (structure.effects && Array.isArray(structure.effects) && structure.effects.length > 0) {
    const shadows: any[] = [];
    for (const effect of structure.effects) {
      if (effect.type === 'DROP_SHADOW' && effect.visible !== false) {
        const dropShadow = effect as DropShadowEffect;
        const { r, g, b } = dropShadow.color;
        const a = dropShadow.color.a ?? 1;
        shadows.push({
          type: 'dropShadow',
          x: roundValue(dropShadow.offset.x),
          y: roundValue(dropShadow.offset.y),
          blur: roundValue(dropShadow.radius),
          spread: dropShadow.spread ? roundValue(dropShadow.spread) : 0,
          color: `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${roundValue(a)})`
        });
      } else if (effect.type === 'INNER_SHADOW' && effect.visible !== false) {
        const innerShadow = effect as InnerShadowEffect;
        const { r, g, b } = innerShadow.color;
        const a = innerShadow.color.a ?? 1;
        shadows.push({
          type: 'innerShadow',
          x: roundValue(innerShadow.offset.x),
          y: roundValue(innerShadow.offset.y),
          blur: roundValue(innerShadow.radius),
          spread: innerShadow.spread ? roundValue(innerShadow.spread) : 0,
          color: `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${roundValue(a)})`
        });
      }
    }
    if (shadows.length > 0) {
      clean.shadows = shadows;
    }
  }

  if (structure.isIcon) {
    clean.isIcon = true;
    if (structure.svgContent) {
      clean.svg = structure.svgContent;
    }
  }

  // Add text properties
  if (structure.textContent !== undefined) {
    clean.text = structure.textContent;
    
    const textStyle: any = {};
    if (structure.fontSize !== undefined && structure.fontSize !== figma.mixed) {
      textStyle.fontSize = structure.fontSize;
    }
    if (structure.fontFamily !== undefined && structure.fontFamily !== figma.mixed) {
      textStyle.fontFamily = structure.fontFamily;
    }
    if (structure.fontWeight !== undefined && structure.fontWeight !== figma.mixed) {
      textStyle.fontWeight = structure.fontWeight;
    }
    if (structure.lineHeight !== undefined && structure.lineHeight !== figma.mixed) {
      const lh = structure.lineHeight as { value?: number; unit: string };
      if (lh.unit === 'PIXELS' && lh.value !== undefined) {
        textStyle.lineHeight = `${roundValue(lh.value)}px`;
      } else if (lh.unit === 'PERCENT' && lh.value !== undefined) {
        textStyle.lineHeight = `${roundValue(lh.value)}%`;
      } else {
        textStyle.lineHeight = 'auto';
      }
    }
    if (structure.letterSpacing !== undefined && structure.letterSpacing !== figma.mixed) {
      const ls = structure.letterSpacing as { value?: number; unit: string };
      if (ls.unit === 'PIXELS' && ls.value !== undefined) {
        textStyle.letterSpacing = `${roundValue(ls.value)}px`;
      } else if (ls.unit === 'PERCENT' && ls.value !== undefined) {
        textStyle.letterSpacing = `${roundValue(ls.value)}%`;
      }
    }
    if (structure.textColor) {
      textStyle.color = structure.textColor;
    }
    if (structure.textAlignHorizontal) {
      textStyle.textAlign = structure.textAlignHorizontal.toLowerCase();
    }
    
    if (Object.keys(textStyle).length > 0) {
      clean.textStyle = textStyle;
    }
  }

  if (structure.children && structure.children.length > 0) {
    clean.children = structure.children.map(child => generateCleanStructure(child));
  }

  return clean;
}

// Convert Figma properties to Tailwind CSS classes
// isRoot: true for root element to use responsive widths instead of fixed large widths
function generateTailwindClasses(structure: BlockStructure, isRoot: boolean = false): string {
  const classes: string[] = [];
  
  // Width - common Tailwind width classes
  // For root elements or very large widths (>500px), use responsive classes to prevent horizontal scroll
  const width = structure.width;
  if (width) {
    const widthMap: { [key: number]: string } = {
      0: 'w-0', 1: 'w-px', 4: 'w-1', 8: 'w-2', 12: 'w-3', 16: 'w-4',
      20: 'w-5', 24: 'w-6', 28: 'w-7', 32: 'w-8', 36: 'w-9', 40: 'w-10',
      44: 'w-11', 48: 'w-12', 56: 'w-14', 64: 'w-16', 80: 'w-20', 96: 'w-24',
      112: 'w-28', 128: 'w-32', 144: 'w-36', 160: 'w-40', 176: 'w-44', 192: 'w-48',
      208: 'w-52', 224: 'w-56', 240: 'w-60', 256: 'w-64', 288: 'w-72', 320: 'w-80', 384: 'w-96'
    };
    if (widthMap[width]) {
      classes.push(widthMap[width]);
    } else if (isRoot && width > 500) {
      // Root elements with large widths should use w-full max-w-full to be responsive
      classes.push('w-full');
      classes.push('max-w-full');
    } else if (width > 768) {
      // Large widths (>768px) should include max-w-full to prevent overflow
      classes.push(`w-[${width}px]`);
      classes.push('max-w-full');
    } else {
      classes.push(`w-[${width}px]`);
    }
  }

  // Height - common Tailwind height classes
  const height = structure.height;
  if (height) {
    const heightMap: { [key: number]: string } = {
      0: 'h-0', 1: 'h-px', 4: 'h-1', 8: 'h-2', 12: 'h-3', 16: 'h-4',
      20: 'h-5', 24: 'h-6', 28: 'h-7', 32: 'h-8', 36: 'h-9', 40: 'h-10',
      44: 'h-11', 48: 'h-12', 56: 'h-14', 64: 'h-16', 80: 'h-20', 96: 'h-24',
      112: 'h-28', 128: 'h-32', 144: 'h-36', 160: 'h-40', 176: 'h-44', 192: 'h-48',
      208: 'h-52', 224: 'h-56', 240: 'h-60', 256: 'h-64', 288: 'h-72', 320: 'h-80', 384: 'h-96'
    };
    if (heightMap[height]) {
      classes.push(heightMap[height]);
    } else {
      classes.push(`h-[${height}px]`);
    }
  }

  // Padding
  if (structure.padding) {
    const { top, right, bottom, left } = structure.padding;
    const paddingMap: { [key: number]: string } = {
      0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3',
      14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10',
      44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24'
    };
    const getPaddingValue = (val: number) => paddingMap[val] || `[${val}px]`;

    if (top === right && right === bottom && bottom === left && top > 0) {
      classes.push(`p-${getPaddingValue(top)}`);
    } else {
      if (top === bottom && left === right && top > 0 && left > 0) {
        classes.push(`py-${getPaddingValue(top)}`);
        classes.push(`px-${getPaddingValue(left)}`);
      } else {
        if (top > 0) classes.push(`pt-${getPaddingValue(top)}`);
        if (right > 0) classes.push(`pr-${getPaddingValue(right)}`);
        if (bottom > 0) classes.push(`pb-${getPaddingValue(bottom)}`);
        if (left > 0) classes.push(`pl-${getPaddingValue(left)}`);
      }
    }
  }

  // Layout mode (Flexbox)
  if (structure.layoutMode) {
    classes.push('flex');
    if (structure.layoutMode === 'VERTICAL') {
      classes.push('flex-col');
    }
    // item spacing -> gap
    if (structure.itemSpacing && structure.itemSpacing > 0) {
      const gapMap: { [key: number]: string } = {
        0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3',
        14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10',
        44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24'
      };
      const gapValue = gapMap[structure.itemSpacing] || `[${structure.itemSpacing}px]`;
      classes.push(`gap-${gapValue}`);
    }

    // Primary axis alignment (justify-content)
    if (structure.primaryAxisAlignItems) {
      const justifyMap: { [key: string]: string } = {
        'MIN': 'justify-start',
        'CENTER': 'justify-center',
        'MAX': 'justify-end',
        'SPACE_BETWEEN': 'justify-between'
      };
      if (justifyMap[structure.primaryAxisAlignItems]) {
        classes.push(justifyMap[structure.primaryAxisAlignItems]);
      }
    }

    // Counter axis alignment (align-items)
    if (structure.counterAxisAlignItems) {
      const alignMap: { [key: string]: string } = {
        'MIN': 'items-start',
        'CENTER': 'items-center',
        'MAX': 'items-end',
        'BASELINE': 'items-baseline'
      };
      if (alignMap[structure.counterAxisAlignItems]) {
        classes.push(alignMap[structure.counterAxisAlignItems]);
      }
    }
  }

  // Border radius
  if (structure.cornerRadius !== undefined && structure.cornerRadius !== 0 && structure.cornerRadius !== figma.mixed) {
    const radius = structure.cornerRadius as number;
    const radiusMap: { [key: number]: string } = {
      2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg',
      12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl', 9999: 'rounded-full'
    };
    if (radiusMap[radius]) {
      classes.push(radiusMap[radius]);
    } else if (radius >= 9999) {
      classes.push('rounded-full');
    } else {
      classes.push(`rounded-[${radius}px]`);
    }
  }

  // Background color from fills
  if (structure.fills && structure.fills !== figma.mixed && Array.isArray(structure.fills)) {
    const solidFill = structure.fills.find((f): f is SolidPaint => f.type === 'SOLID' && f.visible !== false);
    if (solidFill) {
      const { r, g, b } = solidFill.color;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      
      // Common Tailwind colors - check for exact matches
      const colorMatches: { [key: string]: string } = {
        '#ffffff': 'bg-white', '#000000': 'bg-black',
        '#f9fafb': 'bg-gray-50', '#f3f4f6': 'bg-gray-100', '#e5e7eb': 'bg-gray-200',
        '#d1d5db': 'bg-gray-300', '#9ca3af': 'bg-gray-400', '#6b7280': 'bg-gray-500',
        '#4b5563': 'bg-gray-600', '#374151': 'bg-gray-700', '#1f2937': 'bg-gray-800', '#111827': 'bg-gray-900',
        '#ef4444': 'bg-red-500', '#f97316': 'bg-orange-500', '#eab308': 'bg-yellow-500',
        '#22c55e': 'bg-green-500', '#3b82f6': 'bg-blue-500', '#8b5cf6': 'bg-violet-500',
        '#ec4899': 'bg-pink-500'
      };
      const lowerHex = hexColor.toLowerCase();
      if (colorMatches[lowerHex]) {
        classes.push(colorMatches[lowerHex]);
      } else {
        classes.push(`bg-[${hexColor}]`);
      }

      // Opacity
      if (solidFill.opacity !== undefined && solidFill.opacity < 1) {
        const opacityPercent = Math.round(solidFill.opacity * 100);
        classes.push(`bg-opacity-${opacityPercent}`);
      }
    }
  }

  // Node-level opacity (different from fill opacity)
  if (structure.opacity !== undefined && structure.opacity !== 1) {
    const opacityPercent = Math.round(structure.opacity * 100);
    // Tailwind opacity classes: 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100
    const standardOpacities = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
    const closestOpacity = standardOpacities.reduce((prev, curr) => 
      Math.abs(curr - opacityPercent) < Math.abs(prev - opacityPercent) ? curr : prev
    );
    classes.push(`opacity-${closestOpacity}`);
  }

  // Border/Stroke
  if (structure.strokes && Array.isArray(structure.strokes) && structure.strokes.length > 0) {
    const solidStroke = structure.strokes.find((s): s is SolidPaint => s.type === 'SOLID' && s.visible !== false);
    if (solidStroke) {
      const { r, g, b } = solidStroke.color;
      const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
      const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      
      // Border width
      const strokeWidth = structure.strokeWeight !== undefined && structure.strokeWeight !== figma.mixed 
        ? structure.strokeWeight as number
        : 1;
      const borderWidthMap: { [key: number]: string } = {
        0: 'border-0', 1: 'border', 2: 'border-2', 4: 'border-4', 8: 'border-8'
      };
      if (borderWidthMap[strokeWidth]) {
        classes.push(borderWidthMap[strokeWidth]);
      } else {
        classes.push(`border-[${strokeWidth}px]`);
      }
      
      // Border color - common Tailwind colors
      const borderColorMatches: { [key: string]: string } = {
        '#ffffff': 'border-white', '#000000': 'border-black',
        '#f9fafb': 'border-gray-50', '#f3f4f6': 'border-gray-100', '#e5e7eb': 'border-gray-200',
        '#d1d5db': 'border-gray-300', '#9ca3af': 'border-gray-400', '#6b7280': 'border-gray-500',
        '#4b5563': 'border-gray-600', '#374151': 'border-gray-700', '#1f2937': 'border-gray-800', '#111827': 'border-gray-900',
        '#ef4444': 'border-red-500', '#f97316': 'border-orange-500', '#eab308': 'border-yellow-500',
        '#22c55e': 'border-green-500', '#3b82f6': 'border-blue-500', '#8b5cf6': 'border-violet-500',
        '#ec4899': 'border-pink-500'
      };
      const lowerHex = hexColor.toLowerCase();
      if (borderColorMatches[lowerHex]) {
        classes.push(borderColorMatches[lowerHex]);
      } else {
        classes.push(`border-[${hexColor}]`);
      }
      
      // Border opacity if less than 1
      if (solidStroke.opacity !== undefined && solidStroke.opacity < 1) {
        const opacityPercent = Math.round(solidStroke.opacity * 100);
        classes.push(`border-opacity-${opacityPercent}`);
      }
    }
  }

  // Shadow/Effects - Convert Figma effects to Tailwind shadow classes
  if (structure.effects && Array.isArray(structure.effects) && structure.effects.length > 0) {
    // Find drop shadows (most common shadow type)
    const dropShadows = structure.effects.filter(
      (e): e is DropShadowEffect => e.type === 'DROP_SHADOW' && e.visible !== false
    );
    
    // Find inner shadows
    const innerShadows = structure.effects.filter(
      (e): e is InnerShadowEffect => e.type === 'INNER_SHADOW' && e.visible !== false
    );
    
    if (dropShadows.length > 0) {
      // Generate custom shadow from the first (or combined) drop shadow
      const shadowParts: string[] = [];
      for (const shadow of dropShadows) {
        const x = roundValue(shadow.offset.x);
        const y = roundValue(shadow.offset.y);
        const blur = roundValue(shadow.radius);
        const spread = shadow.spread ? roundValue(shadow.spread) : 0;
        const { r, g, b } = shadow.color;
        const a = shadow.color.a ?? 1;
        const color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${roundValue(a)})`;
        shadowParts.push(`${x}px ${y}px ${blur}px ${spread}px ${color}`);
      }
      
      // Try to match common Tailwind shadow presets
      if (dropShadows.length === 1) {
        const shadow = dropShadows[0];
        const x = shadow.offset.x;
        const y = shadow.offset.y;
        const blur = shadow.radius;
        const spread = shadow.spread ?? 0;
        
        // Match approximate Tailwind shadow presets
        if (x === 0 && y === 1 && blur <= 2 && spread <= 0) {
          classes.push('shadow-sm');
        } else if (x === 0 && y >= 1 && y <= 3 && blur >= 2 && blur <= 4 && spread <= 0) {
          classes.push('shadow');
        } else if (x === 0 && y >= 4 && y <= 6 && blur >= 6 && blur <= 10) {
          classes.push('shadow-md');
        } else if (x === 0 && y >= 10 && y <= 15 && blur >= 15 && blur <= 25) {
          classes.push('shadow-lg');
        } else if (x === 0 && y >= 20 && y <= 30 && blur >= 25 && blur <= 50) {
          classes.push('shadow-xl');
        } else if (x === 0 && y >= 25 && blur >= 50) {
          classes.push('shadow-2xl');
        } else {
          // Custom shadow
          classes.push(`shadow-[${shadowParts.join(',_')}]`);
        }
      } else {
        // Multiple shadows - use custom
        classes.push(`shadow-[${shadowParts.join(',_')}]`);
      }
    }
    
    if (innerShadows.length > 0) {
      // Tailwind uses shadow-inner for inner shadows
      const shadow = innerShadows[0];
      const x = roundValue(shadow.offset.x);
      const y = roundValue(shadow.offset.y);
      const blur = roundValue(shadow.radius);
      const { r, g, b } = shadow.color;
      const a = shadow.color.a ?? 1;
      
      // Check if it matches the default inner shadow pattern
      if (x === 0 && y === 2 && blur === 4) {
        classes.push('shadow-inner');
      } else {
        const color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${roundValue(a)})`;
        classes.push(`shadow-[inset_${x}px_${y}px_${blur}px_${color}]`);
      }
    }
  }

  // Text styling classes
  if (structure.textContent !== undefined) {
    // Font size
    if (structure.fontSize !== undefined && structure.fontSize !== figma.mixed) {
      const fontSize = structure.fontSize as number;
      const fontSizeMap: { [key: number]: string } = {
        12: 'text-xs', 14: 'text-sm', 16: 'text-base', 18: 'text-lg',
        20: 'text-xl', 24: 'text-2xl', 30: 'text-3xl', 36: 'text-4xl',
        48: 'text-5xl', 60: 'text-6xl', 72: 'text-7xl', 96: 'text-8xl', 128: 'text-9xl'
      };
      if (fontSizeMap[fontSize]) {
        classes.push(fontSizeMap[fontSize]);
      } else {
        classes.push(`text-[${fontSize}px]`);
      }
    }

    // Font weight
    if (structure.fontWeight !== undefined && structure.fontWeight !== figma.mixed) {
      const fontWeight = structure.fontWeight as number;
      const fontWeightMap: { [key: number]: string } = {
        100: 'font-thin', 200: 'font-extralight', 300: 'font-light',
        400: 'font-normal', 500: 'font-medium', 600: 'font-semibold',
        700: 'font-bold', 800: 'font-extrabold', 900: 'font-black'
      };
      if (fontWeightMap[fontWeight]) {
        classes.push(fontWeightMap[fontWeight]);
      } else {
        classes.push(`font-[${fontWeight}]`);
      }
    }

    // Line height
    if (structure.lineHeight !== undefined && structure.lineHeight !== figma.mixed) {
      const lh = structure.lineHeight as { value?: number; unit: string };
      if (lh.unit === 'PIXELS' && lh.value !== undefined) {
        const roundedValue = roundValue(lh.value);
        const lineHeightMap: { [key: number]: string } = {
          16: 'leading-4', 20: 'leading-5', 24: 'leading-6', 28: 'leading-7',
          32: 'leading-8', 36: 'leading-9', 40: 'leading-10'
        };
        if (lineHeightMap[roundedValue]) {
          classes.push(lineHeightMap[roundedValue]);
        } else {
          classes.push(`leading-[${roundedValue}px]`);
        }
      } else if (lh.unit === 'PERCENT' && lh.value !== undefined) {
        const roundedValue = roundValue(lh.value);
        const percentValue = roundedValue / 100;
        if (percentValue === 1) {
          classes.push('leading-none');
        } else if (percentValue === 1.25) {
          classes.push('leading-tight');
        } else if (percentValue === 1.375) {
          classes.push('leading-snug');
        } else if (percentValue === 1.5) {
          classes.push('leading-normal');
        } else if (percentValue === 1.625) {
          classes.push('leading-relaxed');
        } else if (percentValue === 2) {
          classes.push('leading-loose');
        } else {
          classes.push(`leading-[${roundedValue}%]`);
        }
      }
    }

    // Letter spacing
    if (structure.letterSpacing !== undefined && structure.letterSpacing !== figma.mixed) {
      const ls = structure.letterSpacing as { value?: number; unit: string };
      if (ls.unit === 'PIXELS' && ls.value !== undefined && ls.value !== 0) {
        const roundedLs = roundValue(ls.value);
        if (roundedLs < 0) {
          classes.push('tracking-tighter');
        } else if (roundedLs <= 0.025 * 16) {
          classes.push('tracking-tight');
        } else if (roundedLs <= 0.05 * 16) {
          classes.push('tracking-wide');
        } else if (roundedLs <= 0.1 * 16) {
          classes.push('tracking-wider');
        } else {
          classes.push(`tracking-[${roundedLs}px]`);
        }
      } else if (ls.unit === 'PERCENT' && ls.value !== undefined && ls.value !== 0) {
        classes.push(`tracking-[${roundValue(ls.value)}%]`);
      }
    }

    // Text color
    if (structure.textColor) {
      const colorMatches: { [key: string]: string } = {
        '#ffffff': 'text-white', '#000000': 'text-black',
        '#f9fafb': 'text-gray-50', '#f3f4f6': 'text-gray-100', '#e5e7eb': 'text-gray-200',
        '#d1d5db': 'text-gray-300', '#9ca3af': 'text-gray-400', '#6b7280': 'text-gray-500',
        '#4b5563': 'text-gray-600', '#374151': 'text-gray-700', '#1f2937': 'text-gray-800', '#111827': 'text-gray-900',
        '#ef4444': 'text-red-500', '#f97316': 'text-orange-500', '#eab308': 'text-yellow-500',
        '#22c55e': 'text-green-500', '#3b82f6': 'text-blue-500', '#8b5cf6': 'text-violet-500',
        '#ec4899': 'text-pink-500'
      };
      const lowerColor = structure.textColor.toLowerCase();
      if (colorMatches[lowerColor]) {
        classes.push(colorMatches[lowerColor]);
      } else {
        classes.push(`text-[${structure.textColor}]`);
      }
    }

    // Text alignment
    if (structure.textAlignHorizontal) {
      const alignMap: { [key: string]: string } = {
        'LEFT': 'text-left', 'CENTER': 'text-center', 'RIGHT': 'text-right', 'JUSTIFIED': 'text-justify'
      };
      if (alignMap[structure.textAlignHorizontal]) {
        classes.push(alignMap[structure.textAlignHorizontal]);
      }
    }
  }

  return classes.join(' ');
}

// Generate Tailwind output for entire structure tree
// isRoot is true for the top-level element to use responsive width classes
function generateTailwindOutput(structure: BlockStructure, indent: number = 0, isRoot: boolean = true): string {
  const prefix = '  '.repeat(indent);
  let output = '';
  
  const tailwindClasses = generateTailwindClasses(structure, isRoot);
  output += `${prefix}/* ${structure.name} (${structure.type}) */\n`;
  output += `${prefix}className="${tailwindClasses}"\n`;
  
  if (structure.children && structure.children.length > 0) {
    structure.children.forEach(child => {
      output += '\n' + generateTailwindOutput(child, indent + 1, false);
    });
  }
  
  return output;
}

// Handle codegen event for Dev Mode
figma.codegen.on('generate', async (event: CodegenEvent): Promise<CodegenResult[]> => {
  const node = event.node;
  const structure = await extractBlockStructure(node);
  const cleanStructure = generateCleanStructure(structure);
  const consoleOutput = formatForConsole(structure);
  
  const results: CodegenResult[] = [];

  // JSON Structure output
  if (event.language === 'json' || event.language === 'console') {
    results.push({
      title: 'Block Structure',
      code: JSON.stringify(cleanStructure, null, 2),
      language: 'JSON'
    });
  }

  // Console log format
  if (event.language === 'console') {
    results.push({
      title: 'Console Output',
      code: consoleOutput,
      language: 'PLAINTEXT'
    });
  }

  // If node has SVG icons, add them as separate outputs
  if (structure.isIcon && structure.svgContent) {
    results.push({
      title: `SVG: ${structure.name}`,
      code: structure.svgContent,
      language: 'HTML'
    });
  }

  // Extract all nested icons
  function extractIcons(s: BlockStructure): CodegenResult[] {
    const icons: CodegenResult[] = [];
    if (s.isIcon && s.svgContent) {
      icons.push({
        title: `SVG: ${s.name}`,
        code: s.svgContent,
        language: 'HTML'
      });
    }
    if (s.children) {
      s.children.forEach(child => {
        icons.push(...extractIcons(child));
      });
    }
    return icons;
  }

  const allIcons = extractIcons(structure);
  // Add unique icons (avoid duplicates with root icon)
  allIcons.forEach(icon => {
    if (!results.some(r => r.title === icon.title)) {
      results.push(icon);
    }
  });

  return results;
});

// Count total nodes for progress tracking
function countNodes(node: SceneNode): number {
  let count = 1;
  if ('children' in node) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

// Main plugin logic for regular mode (non-dev mode)
async function main() {
  // Check if running in codegen mode
  if (figma.mode === 'codegen') {
    // In codegen mode, the generate event handler above will be used
    return;
  }

  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.notify('Please select a block/frame to copy its structure');
    figma.closePlugin();
    return;
  }

  figma.showUI(__html__, { width: 500, height: 600 });

  // Count total nodes and show progress
  let totalNodes = 0;
  for (const node of selection) {
    totalNodes += countNodes(node);
  }
  
  let processedNodes = 0;
  const updateProgress = () => {
    processedNodes++;
    if (processedNodes % 10 === 0 || processedNodes === totalNodes) {
      figma.ui.postMessage({
        type: 'progress',
        current: processedNodes,
        total: totalNodes
      });
    }
  };

  const structures: BlockStructure[] = [];
  
  for (const node of selection) {
    const structure = await extractBlockStructure(node, 0, updateProgress);
    structures.push(structure);
  }

  // Generate outputs
  const consoleOutput = structures.map(s => formatForConsole(s)).join('\n\n');
  const jsonOutput = structures.length === 1 
    ? generateCleanStructure(structures[0])
    : structures.map(s => generateCleanStructure(s));
  const tailwindOutput = structures.map(s => generateTailwindOutput(s)).join('\n\n');
  const images = await exportImagesFromRoots(selection, updateProgress);

  // Send to UI
  figma.ui.postMessage({
    type: 'structure',
    consoleOutput: consoleOutput,
    jsonOutput: JSON.stringify(jsonOutput, null, 2),
    tailwindOutput: tailwindOutput,
    rawStructure: jsonOutput,
    debugLogs: debugLogs,
    images: images
  });
  debugLogs = [];
}

// Handle messages from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'close') {
    figma.closePlugin();
  }
  if (msg.type === 'copy-success') {
    figma.notify('Structure copied to clipboard!');
  }
  if (msg.type === 'refresh') {
    await refreshStructure();
  }
};

// Refresh structure from current selection
async function refreshStructure() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.notify('Please select a block/frame to extract its structure');
    return;
  }

  // Count total nodes and show progress
  let totalNodes = 0;
  for (const node of selection) {
    totalNodes += countNodes(node);
  }
  
  let processedNodes = 0;
  const updateProgress = () => {
    processedNodes++;
    if (processedNodes % 10 === 0 || processedNodes === totalNodes) {
      figma.ui.postMessage({
        type: 'progress',
        current: processedNodes,
        total: totalNodes
      });
    }
  };

  const structures: BlockStructure[] = [];
  
  for (const node of selection) {
    const structure = await extractBlockStructure(node, 0, updateProgress);
    structures.push(structure);
  }

  // Generate outputs
  const consoleOutput = structures.map(s => formatForConsole(s)).join('\n\n');
  const jsonOutput = structures.length === 1 
    ? generateCleanStructure(structures[0])
    : structures.map(s => generateCleanStructure(s));
  const tailwindOutput = structures.map(s => generateTailwindOutput(s)).join('\n\n');
  const images = await exportImagesFromRoots(selection, updateProgress);

  // Send to UI
  figma.ui.postMessage({
    type: 'structure',
    consoleOutput: consoleOutput,
    jsonOutput: JSON.stringify(jsonOutput, null, 2),
    tailwindOutput: tailwindOutput,
    rawStructure: jsonOutput,
    debugLogs: debugLogs,
    images: images
  });
  debugLogs = [];

  figma.notify('Block structure refreshed!');
}

main();
