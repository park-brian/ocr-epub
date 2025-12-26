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

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "tiff", "bmp", "avif", "heic", "heif"];

/**
 * Convert a File or ArrayBuffer to base64 string
 * @param {File|ArrayBuffer} input - File object or ArrayBuffer
 * @returns {Promise<string>} Base64 encoded string
 */
export async function fileToBase64(input) {
  const arrayBuffer = typeof input?.arrayBuffer === "function"
    ? await input.arrayBuffer()
    : input;
  const bytes = new Uint8Array(arrayBuffer);
  return btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
}

/**
 * Decode base64 string to Uint8Array
 * @param {string} base64 - Base64 encoded string
 * @returns {Uint8Array} Decoded bytes
 */
export function base64ToBytes(base64) {
  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  const binaryData = atob(data);
  const bytes = new Uint8Array(binaryData.length);
  for (let i = 0; i < binaryData.length; i++) {
    bytes[i] = binaryData.charCodeAt(i);
  }
  return bytes;
}

/**
 * Determine document type for Mistral OCR API
 * @param {File|{name: string}} file - File object or object with name property
 * @returns {"image_url"|"document_url"} Document type for API
 */
export function getDocumentType(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) ? "image_url" : "document_url";
}

/**
 * Get MIME type for a file
 * @param {File|{name: string}} file - File object or object with name property
 * @returns {string} MIME type
 */
export function getMimeType(file) {
  const mimeMap = {
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
  const ext = file.name.split(".").pop().toLowerCase();
  return mimeMap[ext] || "application/octet-stream";
}

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
 * Decode HTML entities in LaTeX content
 * @param {string} str - String with potential HTML entities
 * @returns {string} String with decoded entities
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}


/**
 * Extract LaTeX blocks from markdown before processing
 * Protects LaTeX from being corrupted by markdown parser
 * @param {string} markdown - Raw markdown content
 * @returns {{markdown: string, blocks: Array}} Safe markdown and extracted blocks
 */
function extractLatexBlocks(markdown) {
  const blocks = [];
  let counter = 0;

  // Extract display math $$...$$ (can span multiple lines)
  markdown = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex) => {
    const placeholder = `%%LATEX_DISPLAY_${counter}%%`;
    blocks.push({ placeholder, latex: latex.trim(), display: true });
    counter++;
    return placeholder;
  });

  // Extract inline math $...$ (single line, must look like math, preceded by whitespace or punctuation)
  markdown = markdown.replace(/(?<=[\s([\-:]|^)\$([^$\n]+)\$/g, (match, latex) => {
    // if (!looksLikeMath(latex)) return match;
    const placeholder = `%%LATEX_INLINE_${counter}%%`;
    blocks.push({ placeholder, latex: latex.trim(), display: false });
    counter++;
    return placeholder;
  });

  return { markdown, blocks };
}

/**
 * Restore LaTeX placeholders as SVG in HTML content
 * @param {string} html - HTML with placeholders
 * @param {Array} blocks - Extracted LaTeX blocks
 * @returns {string} HTML with SVG math
 */
function restoreLatexAsSvg(html, blocks) {
  if (typeof MathJax === 'undefined') return html;

  for (const { placeholder, latex, display } of blocks) {
    try {
      const decodedLatex = decodeHtmlEntities(latex);
      const svg = convertLatexToSvg(decodedLatex, display);
      const wrapper = display
        ? `<div class="math-display">${svg}</div>`
        : `<span class="math-inline">${svg}</span>`;
      html = html.replace(placeholder, wrapper);
    } catch (e) {
      // On error, restore original LaTeX syntax
      const original = display ? `$$${latex}$$` : `$${latex}$`;
      html = html.replace(placeholder, original);
    }
  }
  return html;
}

/**
 * Convert LaTeX expression to inline SVG string
 * @param {string} latex - LaTeX expression (without delimiters)
 * @param {boolean} display - True for display math, false for inline
 * @returns {string} SVG markup
 */
export function convertLatexToSvg(latex, display = false) {
  const wrapper = MathJax.tex2svg(latex, { display });
  const svg = wrapper.querySelector('svg');
  return svg.outerHTML;
}

/**
 * Convert markdown to HTML with LaTeX support
 * @param {string} markdown - Markdown content
 * @returns {string} HTML content with SVG math
 */
function markdownToHtml(markdown) {
  const { markdown: safe, blocks } = extractLatexBlocks(markdown || "");
  let html = marked.parse(safe);
  return restoreLatexAsSvg(html, blocks);
}

/**
 * Generate HTML from markdown
 * @param {string} markdown - Markdown content
 * @param {string} title - Document title
 * @returns {string} HTML document
 */
export function generateHTML(markdown, title = "Document") {
  const htmlContent = markdownToHtml(markdown);
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
    .math-display { text-align: center; margin: 1rem 0; }
    .math-inline { vertical-align: middle; }
    .math-inline svg, .math-display svg { vertical-align: middle; }
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
  const htmlContent = markdownToHtml(processedMarkdown);

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
    .math-display { text-align: center; margin: 1em 0; }
    .math-inline { vertical-align: middle; }
    .math-inline svg, .math-display svg { vertical-align: middle; }
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
  const htmlDoc = generateHTML(processedMarkdown, title);
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
    status: "idle",
    progress: 0,
    statusMessage: "",
    outputZip: null,
    outputFileName: "",
    error: null
  });

  const isLoading = () => ["uploading", "processing", "converting"].includes(state.status);
  const canProcess = () => state.apiKey && state.file && !isLoading();
  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  function setFile(file) {
    if (file) setState({ file, status: "idle", error: null, outputZip: null });
  }

  async function processDocument() {
    setState({ status: "uploading", progress: 10, statusMessage: "Preparing document...", error: null, outputZip: null });
    try {
      const options = { excludeHeaders: state.excludeHeaders, excludeFooters: state.excludeFooters };
      setState({ status: "processing", progress: 30, statusMessage: "Sending to Mistral OCR..." });
      const ocrResult = await performOCR(state.file, state.apiKey, options);
      setState({ status: "converting", progress: 60, statusMessage: "Converting to multiple formats..." });
      const outputZip = await generateOutputZip(ocrResult, state.file.name, options);
      const outputFileName = state.file.name.replace(/\.[^.]+$/, "") + "-ocr.zip";
      setState({ status: "complete", progress: 100, statusMessage: "Processing complete!", outputZip, outputFileName });
    } catch (error) {
      console.error("Processing error:", error);
      setState({ status: "error", progress: 0, statusMessage: "", error: error.message || "An unexpected error occurred" });
    }
  }

  function downloadZip() {
    if (!state.outputZip) return;
    const url = URL.createObjectURL(state.outputZip);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.outputFileName;
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
            disabled=${isLoading}
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

      <!-- Progress -->
      <${Show} when=${() => state.status !== "idle"}>
        <div class="mb-3">
          <div class="progress mb-2" style="height: 8px;">
            <div
              class=${() => `progress-bar ${state.status === 'error' ? 'bg-danger' : ''}`}
              role="progressbar"
              style=${() => `width: ${state.progress}%`}
            ></div>
          </div>
          <small class="text-muted">${() => state.statusMessage}</small>
        </div>
      <//>

      <!-- Buttons -->
      <div class="d-flex gap-2 flex-wrap">
        <button type="button" class="btn btn-primary" onClick=${(e) => processDocument()} disabled=${() => !canProcess()}>
          <${Show} when=${isLoading} fallback=${html`<span><i class="bi bi-play-fill me-1"></i>Process Document</span>`}>
            <span><span class="spinner-border spinner-border-sm me-1" role="status"></span>Processing...</span>
          <//>
        </button>

        <${Show} when=${() => state.outputZip}>
          <button type="button" class="btn btn-success" onClick=${(e) => downloadZip()}>
            <i class="bi bi-download me-1"></i>Download ${() => state.outputFileName}
          </button>
        <//>

        <${Show} when=${() => state.status === "complete" || state.status === "error"}>
          <button type="button" class="btn btn-outline-secondary"
            onClick=${(e) => setState({ file: null, status: "idle", progress: 0, statusMessage: "", outputZip: null, outputFileName: "", error: null })}>
            <i class="bi bi-arrow-counterclockwise me-1"></i>Reset
          </button>
        <//>
      </div>

      <footer class="mt-4 pt-4 border-top text-center">
        <small class="text-muted">
          Powered by <a href="https://docs.mistral.ai/capabilities/vision/#extracting-structured-data-with-ocr" target="_blank" rel="noopener">Mistral OCR</a>
        </small>
      </footer>
    </div>
  `;
}
// #endregion

// #region Render
if (typeof document !== "undefined") {
  render(App, document.getElementById("app"));
}
// #endregion
