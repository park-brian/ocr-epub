import { getMimeType, getDocumentType, escapeXML, fileToBase64, performOCR, inlineTableContent, combineMarkdown } from "./app.js";

// Test utilities
const assert = (condition, message) => {
  if (!condition) throw new Error(message || "Assertion failed");
};

async function runTestSuite(tests) {
  let passed = 0, failed = 0;
  for (const test of tests) {
    const testName = test.name || "Anonymous test";
    try {
      await test();
      console.log(`PASS: ${testName}`);
      passed++;
    } catch (e) {
      console.error(`FAIL: ${testName}\n   Error: ${e.message}`);
      failed++;
    }
  }
  console.log(`Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

// Unit tests
function testGetMimeType() {
  assert(getMimeType({ name: "test.pdf" }) === "application/pdf", "PDF mime type");
  assert(getMimeType({ name: "test.png" }) === "image/png", "PNG mime type");
  assert(getMimeType({ name: "test.jpg" }) === "image/jpeg", "JPG mime type");
  assert(getMimeType({ name: "test.jpeg" }) === "image/jpeg", "JPEG mime type");
  assert(getMimeType({ name: "test.unknown" }) === "application/octet-stream", "Unknown extension");
}

function testGetDocumentType() {
  assert(getDocumentType({ name: "test.pdf" }) === "document_url", "PDF is document");
  assert(getDocumentType({ name: "test.docx" }) === "document_url", "DOCX is document");
  assert(getDocumentType({ name: "test.png" }) === "image_url", "PNG is image");
  assert(getDocumentType({ name: "test.jpg" }) === "image_url", "JPG is image");
  assert(getDocumentType({ name: "test.webp" }) === "image_url", "WEBP is image");
}

function testEscapeXML() {
  assert(escapeXML("Hello") === "Hello", "Plain text unchanged");
  assert(escapeXML("<div>") === "&lt;div&gt;", "Escapes angle brackets");
  assert(escapeXML("&") === "&amp;", "Escapes ampersand");
  assert(escapeXML('"quoted"') === "&quot;quoted&quot;", "Escapes double quotes");
  assert(escapeXML("") === "", "Empty string");
  assert(escapeXML(null) === "", "Null returns empty");
}

async function testFileToBase64() {
  const text = "Hello, World!";
  const encoder = new TextEncoder();
  const buffer = encoder.encode(text).buffer;
  const base64 = await fileToBase64(buffer);
  assert(base64 === "SGVsbG8sIFdvcmxkIQ==", "Encodes text to base64");
}

function testInlineTableContent() {
  // Test basic table inlining
  const markdown = "# Title\n\n[tbl-0.md](tbl-0.md)\n\nMore text";
  const tables = [{ id: "tbl-0.md", content: "| A | B |\n| --- | --- |\n| 1 | 2 |" }];
  const result = inlineTableContent(markdown, tables);
  assert(result.includes("| A | B |"), "Table content should be inlined");
  assert(!result.includes("[tbl-0.md](tbl-0.md)"), "Placeholder should be removed");

  // Test multiple tables
  const markdown2 = "[tbl-0.md](tbl-0.md)\n[tbl-1.md](tbl-1.md)";
  const tables2 = [
    { id: "tbl-0.md", content: "Table 0" },
    { id: "tbl-1.md", content: "Table 1" }
  ];
  const result2 = inlineTableContent(markdown2, tables2);
  assert(result2.includes("Table 0"), "First table inlined");
  assert(result2.includes("Table 1"), "Second table inlined");

  // Test empty/null inputs
  assert(inlineTableContent("", []) === "", "Empty markdown returns empty");
  assert(inlineTableContent("text", null) === "text", "Null tables returns original");
  assert(inlineTableContent(null, []) === null, "Null markdown returns null");
}

function testCombineMarkdownWithTables() {
  // Simulate OCR result structure similar to sample.json
  const ocrResult = {
    pages: [
      {
        index: 0,
        markdown: "# Page 1\n\n[tbl-0.md](tbl-0.md)",
        tables: [{ id: "tbl-0.md", content: "| Col1 | Col2 |\n| --- | --- |\n| A | B |" }]
      },
      {
        index: 1,
        markdown: "# Page 2\n\nNo tables here"
      }
    ]
  };

  const combined = combineMarkdown(ocrResult);
  assert(combined.includes("| Col1 | Col2 |"), "Table content should be in combined output");
  assert(!combined.includes("[tbl-0.md](tbl-0.md)"), "Table placeholder should be replaced");
  assert(combined.includes("# Page 1"), "Page 1 content present");
  assert(combined.includes("# Page 2"), "Page 2 content present");
  assert(combined.includes("---"), "Page separator present");
}


// Integration tests (test actual UI state)
const waitFor = (selector, timeout = 5000) => new Promise((resolve, reject) => {
  const el = document.querySelector(selector);
  if (el) return resolve(el);
  const observer = new MutationObserver(() => {
    const el = document.querySelector(selector);
    if (el) { observer.disconnect(); resolve(el); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout waiting for ${selector}`)); }, timeout);
});

async function testApiKeyLoadedFromLocalStorage() {
  const apiKeyInput = await waitFor("#apiKey");
  const storedKey = localStorage.getItem("MISTRAL_API_KEY");
  assert(apiKeyInput.value === storedKey, `API key input has stored value (expected "${storedKey}", got "${apiKeyInput.value}")`);
}

async function testOcrWithLocalPdf() {
  const apiKey = localStorage.getItem("MISTRAL_API_KEY");
  assert(apiKey, "MISTRAL_API_KEY is set");

  // Fetch local PDF and convert to File-like object
  console.log("Fetching docs/sample.pdf...");
  const response = await fetch("/docs/sample.pdf");
  assert(response.ok, `Failed to fetch PDF: ${response.status}`);
  const blob = await response.blob();
  const file = new File([blob], "sample.pdf", { type: "application/pdf" });

  console.log("Calling performOCR with local PDF file...");
  try {
    const result = await performOCR(file, apiKey);
    assert(result, "OCR returned a result");
    assert(result.pages, "OCR result has pages");
    assert(result.pages.length > 0, `OCR returned ${result.pages.length} pages`);
    console.log("OCR returned", result.pages.length, "pages");
  } catch (err) {
    console.error("OCR error:", err.message);
    throw err;
  }
}

async function testFileUploadOcrFlow() {
  const apiKey = localStorage.getItem("MISTRAL_API_KEY");
  assert(apiKey, "MISTRAL_API_KEY is set");

  // Fetch local PDF
  console.log("Fetching docs/sample.pdf for upload test...");
  const response = await fetch("/docs/sample.pdf");
  assert(response.ok, `Failed to fetch PDF: ${response.status}`);
  const blob = await response.blob();
  const file = new File([blob], "sample.pdf", { type: "application/pdf" });

  // Use DataTransfer to create a FileList and set on input
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  // Find the file input and set files
  const fileInput = await waitFor('input[type="file"]');
  fileInput.files = dataTransfer.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  // Click submit
  const submitBtn = await waitFor(".btn-primary");
  assert(!submitBtn.disabled, "Submit button should be enabled after file upload");
  submitBtn.click();

  // Wait for download button (up to 60s)
  console.log("Waiting for OCR to complete...");
  const downloadBtn = await waitFor(".btn-success", 60000);
  assert(downloadBtn.textContent.includes("Download"), "Download button appears after OCR");
  console.log("File upload OCR flow completed!");
}

const allTests = [
  testGetMimeType,
  testGetDocumentType,
  testEscapeXML,
  testFileToBase64,
  testInlineTableContent,
  testCombineMarkdownWithTables,
  testApiKeyLoadedFromLocalStorage,
  testOcrWithLocalPdf,
  testFileUploadOcrFlow,
];

export async function runTests() {
  try {
    console.log("Running tests...");
    window.TESTS_DONE = false;
    await runTestSuite(allTests);
  } catch (err) {
    console.error("Test error:", err);
  } finally {
    window.TESTS_DONE = true;
  }
}
