// #region Imports
import { render } from "solid-js/web";
import { createSignal, Show } from "solid-js";
import { createStore } from "solid-js/store";
import html from "solid-js/html";
import JSZip from "jszip";
import { marked } from "marked";
import { runTests } from "./app.test.js";
// #endregion

// Run tests if ?test=1 query param
if (new URLSearchParams(location.search).get("test") === "1") setTimeout(runTests, 0);

// #region File Utilities

const MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  epub: "application/epub+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif"
};
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "tiff", "bmp", "avif", "heic", "heif"]);

const getExt = file => file.name.split(".").pop().toLowerCase();

export async function fileToBase64(input) {
  const arrayBuffer = typeof input?.arrayBuffer === "function" ? await input.arrayBuffer() : input;
  return btoa(new Uint8Array(arrayBuffer).reduce((s, b) => s + String.fromCharCode(b), ""));
}

export function base64ToBytes(base64) {
  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

export const getDocumentType = file => IMAGE_EXTS.has(getExt(file)) ? "image_url" : "document_url";
export const getMimeType = file => MIME_TYPES[getExt(file)] || "application/octet-stream";

// #endregion

// #region OCR API

/**
 * Perform OCR using Mistral API
 * @param {File} file - File to process
 * @param {string} apiKey - Mistral API key
 * @returns {Promise<{pages: Array}>} OCR result
 */
export async function performOCR(file, apiKey, options = {}) {
  const base64Data = await fileToBase64(file);
  const docType = getDocumentType(file);
  const mimeType = getMimeType(file);
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const response = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: {
        type: docType,
        [docType]: dataUrl
      },
      include_image_base64: true,
      table_format: "markdown",
      // When excluding, extract separately (text only). When including, keep in content (with images).
      extract_header: options.excludeHeaders || false,
      extract_footer: options.excludeFooters || false
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || `OCR failed: ${response.status}`);
  }

  return response.json();
}
// #endregion

// #region Conversion Functions

/**
 * Combine all pages into single markdown
 * @param {{pages: Array<{index: number, markdown: string}>}} ocrResult - OCR result
 * @returns {string} Combined markdown
 */
export function combineMarkdown(ocrResult) {
  if (!ocrResult?.pages?.length) return "";
  return ocrResult.pages
    .sort((a, b) => a.index - b.index)
    .map(page => inlineTableContent(page.markdown || "", page.tables))
    .join("\n\n---\n\n");
}

/**
 * Extract images from OCR result
 * @param {{pages: Array<{images?: Array}>}} ocrResult - OCR result
 * @returns {Map<string, {data: string, format: string}>} Image map
 */
export function extractImages(ocrResult) {
  const images = new Map();

  if (!ocrResult?.pages) return images;

  for (const page of ocrResult.pages) {
    if (page.images) {
      for (const img of page.images) {
        // img structure: { id: "img-0.jpeg", image_base64: "..." }
        const id = img.id || img.name;
        if (id && img.image_base64) {
          images.set(id, {
            data: img.image_base64,
            format: id.split(".").pop()
          });
        }
      }
    }
  }

  return images;
}

/**
 * Update image paths in markdown to include images/ prefix
 * @param {string} markdown - Markdown content
 * @param {string} imagePrefix - Prefix for image paths
 * @returns {string} Updated markdown
 */
export function processMarkdownImages(markdown, imagePrefix = "images/") {
  if (!markdown) return "";
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, src) => {
      if (!src.startsWith("http") && !src.startsWith("data:") && !src.startsWith(imagePrefix)) {
        return `![${alt}](${imagePrefix}${src})`;
      }
      return match;
    }
  );
}

/**
 * Replace table placeholders with actual table content
 * @param {string} markdown - Markdown content
 * @param {Array<{id: string, content: string}>} tables - Tables array from OCR
 * @returns {string} Markdown with tables inlined
 */
export function inlineTableContent(markdown, tables) {
  if (!markdown || !tables?.length) return markdown;
  let result = markdown;
  for (const table of tables) {
    if (table.id && table.content) {
      const placeholder = `[${table.id}](${table.id})`;
      result = result.replace(placeholder, table.content);
    }
  }
  return result;
}

/**
 * Convert SVG element to PNG data URL via canvas
 * @param {SVGElement} svg - SVG element to convert
 * @param {number} scale - Scale factor for resolution (default 1x)
 * @returns {Promise<string>} PNG data URL
 */
async function svgToPngDataUrl(svg, scale = 1) {
  const clone = svg.cloneNode(true);

  // MathJax uses 'ex' units - convert to pixels (1ex ≈ 8px at 16px font)
  const exToPx = 8;
  const widthAttr = svg.getAttribute('width');
  const heightAttr = svg.getAttribute('height');
  let width = 100, height = 100;

  if (widthAttr?.endsWith('ex')) {
    width = Math.ceil(parseFloat(widthAttr) * exToPx);
  } else if (widthAttr) {
    width = parseFloat(widthAttr) || 100;
  }
  if (heightAttr?.endsWith('ex')) {
    height = Math.ceil(parseFloat(heightAttr) * exToPx);
  } else if (heightAttr) {
    height = parseFloat(heightAttr) || 100;
  }

  // Set explicit pixel dimensions
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);

  // MathJax uses currentColor - replace with black for standalone rendering
  clone.style.color = '#000';
  clone.querySelectorAll('*').forEach(el => {
    if (el.getAttribute('fill') === 'currentColor') el.setAttribute('fill', '#000');
    if (el.getAttribute('stroke') === 'currentColor') el.setAttribute('stroke', '#000');
  });

  // Add xmlns for standalone SVG
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const svgString = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load SVG'));
    };
    img.src = url;
  });
}

/**
 * Convert LaTeX to PNG image, falling back to original syntax if unavailable
 * @param {string} tex - LaTeX string
 * @param {boolean} display - Display mode (block) vs inline
 * @returns {Promise<string>} HTML img tag or raw LaTeX
 */
async function latexToImage(tex, display) {
  if (typeof MathJax === 'undefined') return display ? `$$${tex}$$` : `$${tex}$`;
  try {
    // Decode HTML entities that may be in OCR output
    const decoded = tex.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const container = MathJax.tex2svg(decoded, { display });
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('No SVG generated');

    const pngDataUrl = await svgToPngDataUrl(svg);
    const cls = display ? 'math-display' : 'math-inline';
    const style = display ? 'display:block;' : 'display:inline-block;';
    const altText = escapeXML(tex).replace(/[\r\n]+/g, ' ').trim();
    return `<img class="${cls}" src="${pngDataUrl}" alt="${altText}" style="${style}">`;
  } catch {
    return display ? `$$${tex}$$` : `$${tex}$`;
  }
}

/**
 * Convert markdown to HTML, rendering LaTeX as PNG images
 */
async function markdownToHtml(markdown) {
  if (!markdown) return "";

  // Collect all LaTeX matches with their positions
  const replacements = [];

  // Display math: $$...$$
  for (const match of markdown.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    replacements.push({ start: match.index, end: match.index + match[0].length, tex: match[1], display: true });
  }

  // Inline math: $...$ (with lookbehind for word boundary)
  for (const match of markdown.matchAll(/(?<=[\s([\-:]|^)\$([^$\n]+)\$/g)) {
    replacements.push({ start: match.index, end: match.index + match[0].length, tex: match[1], display: false });
  }

  // Sort by position descending so we can replace from end to start
  replacements.sort((a, b) => b.start - a.start);

  // Convert each LaTeX to PNG (in parallel for speed)
  const converted = await Promise.all(replacements.map(r => latexToImage(r.tex, r.display)));

  // Replace from end to start to preserve indices
  let result = markdown;
  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i];
    result = result.slice(0, r.start) + converted[i] + result.slice(r.end);
  }

  return marked.parse(result);
}

/**
 * Generate HTML from markdown
 * @param {string} markdown - Markdown content
 * @param {string} title - Document title
 * @returns {Promise<string>} HTML document
 */
export async function generateHTML(markdown, title = "Document") {
  const htmlContent = await markdownToHtml(markdown);
  const escapedTitle = escapeXML(title);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      line-height: 1.6;
    }
    img, svg { max-width: 100%; height: auto; }
    pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; }
    code { background: #f5f5f5; padding: 0.2em 0.4em; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    th { background: #f5f5f5; }
    hr { margin: 2rem 0; border: none; border-top: 1px solid #ddd; }
    blockquote { border-left: 4px solid #ddd; margin: 1rem 0; padding-left: 1rem; color: #666; }
    .math-display { display: block; text-align: center; margin: 1rem 0; }
    .math-inline { display: inline-block; vertical-align: middle; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}

/**
 * Escape XML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeXML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
// #endregion

// #region EPUB Generation

/**
 * Generate EPUB e-book
 * @param {string} markdown - Markdown content
 * @param {Map<string, {data: string, format: string}>} images - Image map
 * @param {string} title - Document title
 * @returns {Promise<JSZip>} EPUB as JSZip object
 */
export async function generateEPUB(markdown, images, title = "Document") {
  const zip = new JSZip();

  // 1. mimetype (must be first, uncompressed)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  // 2. META-INF/container.xml
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // 3. Generate unique ID and timestamp
  const uuid = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const escapedTitle = escapeXML(title);

  // 4. Build manifest items for images
  const imageManifest = [];
  images.forEach((img, id) => {
    const mimeType = img.format === "png" ? "image/png" :
                     img.format === "gif" ? "image/gif" :
                     img.format === "webp" ? "image/webp" : "image/jpeg";
    const safeId = id.replace(/[^a-z0-9]/gi, "_");
    imageManifest.push(`    <item id="${safeId}" href="images/${id}" media-type="${mimeType}"/>`);
  });

  // 5. OEBPS/content.opf (package document)
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapedTitle}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>OCR EPUB</dc:creator>
    <meta property="dcterms:modified">${timestamp}</meta>
  </metadata>
  <manifest>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${imageManifest.join("\n")}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`);

  // 6. OEBPS/nav.xhtml (navigation document)
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="content.xhtml">${escapedTitle}</a></li>
    </ol>
  </nav>
</body>
</html>`);

  // 7. OEBPS/content.xhtml (main content)
  const processedMarkdown = processMarkdownImages(markdown, "images/");
  const htmlContent = await markdownToHtml(processedMarkdown);

  zip.file("OEBPS/content.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapedTitle}</title>
  <style>
    body { font-family: serif; margin: 1em; line-height: 1.6; }
    img, svg { max-width: 100%; height: auto; }
    pre { background: #f5f5f5; padding: 1em; overflow-x: auto; white-space: pre-wrap; }
    code { background: #f5f5f5; padding: 0.2em; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 0.5em; }
    .math-display { display: block; text-align: center; margin: 1em 0; }
    .math-inline { display: inline-block; vertical-align: middle; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`);

  // 8. Add images to OEBPS/images/
  images.forEach((img, id) => {
    const bytes = base64ToBytes(img.data);
    zip.file(`OEBPS/images/${id}`, bytes);
  });

  return zip;
}
// #endregion

// #region Output Generation

/**
 * Generate output ZIP with all formats
 * @param {{pages: Array}} ocrResult - OCR result
 * @param {string} originalFileName - Original file name
 * @param {{excludeHeaders?: boolean, excludeFooters?: boolean}} options - Options
 * @returns {Promise<Blob>} ZIP blob
 */
export async function generateOutputZip(ocrResult, originalFileName, options = {}) {
  const zip = new JSZip();

  // Extract title from filename
  const title = originalFileName.replace(/\.[^.]+$/, "") || "Document";

  // Process OCR results
  const rawMarkdown = combineMarkdown(ocrResult);
  const images = extractImages(ocrResult);
  const processedMarkdown = processMarkdownImages(rawMarkdown, "images/");

  // 1. Add content.md
  zip.file("content.md", processedMarkdown);

  // 2. Add content.html
  const htmlDoc = await generateHTML(processedMarkdown, title);
  zip.file("content.html", htmlDoc);

  // 3. Add images folder
  images.forEach((img, id) => {
    const bytes = base64ToBytes(img.data);
    zip.file(`images/${id}`, bytes);
  });

  // 4. Generate and embed EPUB
  const epubZip = await generateEPUB(rawMarkdown, images, title);
  const epubArrayBuffer = await epubZip.generateAsync({
    type: "arraybuffer"
  });
  zip.file("content.epub", epubArrayBuffer);

  // Generate final ZIP
  return zip.generateAsync({ type: "blob" });
}
// #endregion

// #region App

function App() {
  let fileInputRef;
  const [dragOver, setDragOver] = createSignal(false);
  const [state, setState] = createStore({
    apiKey: localStorage.getItem("MISTRAL_API_KEY") || "",
    file: null,
    excludeHeaders: false,
    excludeFooters: false,
    status: "idle", // idle | processing | complete | error
    error: null,
    output: null // { blob, filename }
  });

  const isProcessing = () => state.status === "processing";
  const canProcess = () => state.apiKey && state.file && !isProcessing();
  const formatFileSize = bytes => bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / (1024 * 1024)).toFixed(1) + " MB";

  function setFile(file) {
    if (file) setState({ file, status: "idle", error: null, output: null });
  }

  async function processDocument() {
    setState({ status: "processing", error: null, output: null });
    try {
      const options = { excludeHeaders: state.excludeHeaders, excludeFooters: state.excludeFooters };
      const ocrResult = await performOCR(state.file, state.apiKey, options);
      const blob = await generateOutputZip(ocrResult, state.file.name, options);
      const filename = state.file.name.replace(/\.[^.]+$/, "") + "-ocr.zip";
      setState({ status: "complete", output: { blob, filename } });
    } catch (error) {
      console.error("Processing error:", error);
      setState({ status: "error", error: error.message || "An unexpected error occurred" });
    }
  }

  function downloadZip() {
    if (!state.output) return;
    const url = URL.createObjectURL(state.output.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.output.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return html`
    <div class="container py-4" style="max-width: 600px;">
      <header class="mb-4 text-center">
        <h1 class="h3">OCR EPUB</h1>
        <p class="text-muted">Extract text from documents using Mistral OCR</p>
      </header>

      <!-- API Key -->
      <div class="mb-3">
        <label for="apiKey" class="form-label">Mistral API Key</label>
        <input
          type="text"
          class="form-control font-monospace"
          id="apiKey"
          placeholder="Enter your Mistral API key"
          value=${() => state.apiKey}
          onInput=${(e) => { setState("apiKey", e.target.value); localStorage.setItem("MISTRAL_API_KEY", e.target.value); }}
        />
        <div class="form-text">Your API key is stored locally in your browser.</div>
      </div>

      <!-- File Upload -->
      <div class="mb-3">
        <label class="form-label">Upload Document</label>
        <div
          class=${() => `border rounded p-4 text-center ${dragOver() ? 'border-primary bg-primary bg-opacity-10' : ''}`}
          style="border-style: dashed; cursor: pointer;"
          onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave=${(e) => { e.preventDefault(); setDragOver(false); }}
          onDrop=${(e) => { e.preventDefault(); setDragOver(false); setFile(e.dataTransfer?.files?.[0]); }}
          onClick=${(e) => fileInputRef?.click()}
        >
          <input
            ref=${(el) => fileInputRef = el}
            type="file"
            class="d-none"
            accept=".pdf,.docx,.pptx,.txt,.epub,.png,.jpg,.jpeg,.gif,.webp,.tiff,.bmp"
            onChange=${(e) => setFile(e.target?.files?.[0])}
            disabled=${isProcessing}
          />
          <${Show}
            when=${() => state.file}
            fallback=${html`
              <div>
                <i class="bi bi-cloud-upload fs-1 text-muted"></i>
                <p class="mb-0 mt-2">Drag and drop a file here, or click to select</p>
                <small class="text-muted">Supports PDF, DOCX, PPTX, images, and more</small>
              </div>
            `}
          >
            <div>
              <i class="bi bi-file-earmark-check fs-1 text-success"></i>
              <p class="mb-0 mt-2 fw-medium">${() => state.file?.name}</p>
              <small class="text-muted">${() => formatFileSize(state.file?.size || 0)}</small>
            </div>
          <//>
        </div>
      </div>

      <!-- Options -->
      <div class="mb-3">
        <div class="form-check">
          <input type="checkbox" class="form-check-input" id="excludeHeaders"
            checked=${() => state.excludeHeaders} onChange=${(e) => setState("excludeHeaders", e.target.checked)} />
          <label class="form-check-label" for="excludeHeaders">Exclude headers</label>
        </div>
        <div class="form-check">
          <input type="checkbox" class="form-check-input" id="excludeFooters"
            checked=${() => state.excludeFooters} onChange=${(e) => setState("excludeFooters", e.target.checked)} />
          <label class="form-check-label" for="excludeFooters">Exclude footers</label>
        </div>
      </div>

      <!-- Error -->
      <${Show} when=${() => state.error}>
        <div class="alert alert-danger alert-dismissible fade show" role="alert">
          <strong>Error:</strong> ${() => state.error}
          <button type="button" class="btn-close" onClick=${(e) => setState("error", null)} aria-label="Close"></button>
        </div>
      <//>

      <!-- Buttons -->
      <div class="d-flex gap-2 flex-wrap">
        <button type="button" class="btn btn-primary" onClick=${(e) => processDocument()} disabled=${() => !canProcess()}>
          <${Show} when=${isProcessing} fallback=${html`<span><i class="bi bi-play-fill me-1"></i>Process Document</span>`}>
            <span><span class="spinner-border spinner-border-sm me-1" role="status"></span>Processing...</span>
          <//>
        </button>

        <${Show} when=${() => state.output}>
          <button type="button" class="btn btn-success" onClick=${(e) => downloadZip()}>
            <i class="bi bi-download me-1"></i>Download ${() => state.output?.filename}
          </button>
        <//>

        <${Show} when=${() => state.status === "complete" || state.status === "error"}>
          <button type="button" class="btn btn-outline-secondary"
            onClick=${(e) => setState({ file: null, status: "idle", error: null, output: null })}>
            <i class="bi bi-arrow-counterclockwise me-1"></i>Reset
          </button>
        <//>
      </div>

    </div>
  `;
}
// #endregion

// #region Render
render(App, document.getElementById("app"));
// #endregion
