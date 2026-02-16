# PDF and Document Processing for Financial Documents

This guide covers tools and approaches for processing PDFs and other documents, with a focus on tax and financial documents.

## Executive Summary

**Claude has native PDF support** (as of recent updates) for up to 100 pages and 32MB max. This is the simplest solution for most use cases.

**For financial/tax documents specifically**, you may want local processing for:
- Privacy (sensitive documents never leave your machine)
- Table extraction (financial statements, tax forms)
- OCR for scanned receipts and documents
- Batch processing of many files

## Option 1: Claude Native PDF API (Recommended for Most Cases)

**Pros:**
- Zero setup required
- Works immediately in any Claude session
- Handles text extraction, layout analysis, images
- Up to 100 pages, 32MB max per document

**Cons:**
- Document data sent to Anthropic (privacy concern for sensitive tax/financial docs)
- 100-page limit (may need splitting for large documents)
- Cannot extract structured data (e.g., tables as DataFrames)

**Use when:**
- General PDF reading and analysis
- Documents under 100 pages
- Privacy is not a primary concern
- You don't need structured table extraction

**Example usage:**
```markdown
User: "Analyze this tax form [attaches 1040.pdf]"
Claude: [Reads PDF natively and analyzes]
```

## Option 2: MCP Server for PDF Processing

**Recommended: SylphxAI/pdf-reader-mcp**
- GitHub: https://github.com/SylphxAI/pdf-reader-mcp
- Stars: 496 (most popular PDF MCP server)
- Features: Text extraction, metadata, page-by-page reading
- Installation: `npm install -g @sylphxai/pdf-reader-mcp`

**Pros:**
- Integrates with Claude Code's MCP architecture
- Can process PDFs locally (privacy)
- Structured interface for page-by-page access
- Supports metadata extraction

**Cons:**
- Limited table extraction (basic text only)
- No OCR support
- May not handle complex financial document layouts well

**Configuration:**
Add to `data/sessions/{group}/.claude/settings.json`:
```json
{
  "mcpServers": {
    "pdf-reader": {
      "command": "npx",
      "args": ["-y", "@sylphxai/pdf-reader-mcp"]
    }
  }
}
```

## Option 3: Local Python Stack (Recommended for Tax/Financial Documents)

**Best for sensitive financial documents that require privacy and structured data extraction.**

### Core Tools

#### 1. pdfplumber (Best for structured documents with tables)
- GitHub: https://github.com/jsvine/pdfplumber
- Stars: 6,400+
- License: MIT

**Why it's excellent for financial documents:**
- Extracts tables as structured data (CSV, pandas DataFrame)
- Preserves table structure from financial statements
- Handles multi-column layouts common in tax forms
- Text positioning data for custom parsing

**Installation in container:**
```dockerfile
# Add to container/Dockerfile
RUN pip install pdfplumber pandas openpyxl
```

**Example usage in agent:**
```python
import pdfplumber
import pandas as pd

with pdfplumber.open('/workspace/tax_return.pdf') as pdf:
    # Extract all tables from first page
    page = pdf.pages[0]
    tables = page.extract_tables()

    # Convert to DataFrame for analysis
    df = pd.DataFrame(tables[0][1:], columns=tables[0][0])

    # Save as CSV for Claude to analyze
    df.to_csv('/workspace/extracted_table.csv', index=False)
```

#### 2. Camelot (Gold standard for table extraction)
- GitHub: https://github.com/camelot-dev/camelot
- Stars: 3,200+
- License: MIT

**Why it's the gold standard:**
- Specifically designed for table extraction
- Handles complex tables that pdfplumber misses
- Two extraction methods: Stream (text-based) and Lattice (border detection)
- Quality metrics to validate extraction accuracy

**Installation:**
```dockerfile
RUN pip install camelot-py[cv] opencv-python
```

**Example usage:**
```python
import camelot

# Extract tables from financial statement
tables = camelot.read_pdf('/workspace/financial_statement.pdf', flavor='lattice')

# Export all tables
for i, table in enumerate(tables):
    table.to_csv(f'/workspace/table_{i}.csv')
    print(f"Table {i}: {table.accuracy}% accuracy")
```

#### 3. Tesseract OCR (For scanned documents)
- GitHub: https://github.com/tesseract-ocr/tesseract
- Stars: 60,000+
- License: Apache 2.0

**Critical for:**
- Scanned receipts
- Paper tax forms that were photographed
- Old documents without searchable text

**Installation:**
```dockerfile
RUN apt-get update && apt-get install -y tesseract-ocr
RUN pip install pytesseract Pillow
```

**Example usage:**
```python
from PIL import Image
import pytesseract

# OCR a scanned receipt
image = Image.open('/workspace/receipt.jpg')
text = pytesseract.image_to_string(image)

# Save extracted text
with open('/workspace/receipt.txt', 'w') as f:
    f.write(text)
```

#### 4. Marker (Converts PDFs to LLM-friendly Markdown)
- GitHub: https://github.com/VikParuchuri/marker
- Stars: 17,000+
- License: GPL-3.0

**Why it's useful:**
- Converts PDFs to clean Markdown that Claude can analyze
- Preserves structure (headings, lists, tables)
- Handles complex layouts
- Optimized for LLM consumption

**Installation:**
```dockerfile
RUN pip install marker-pdf
```

**Example usage:**
```bash
marker /workspace/tax_doc.pdf --output_dir /workspace/converted
# Produces tax_doc.md with structured content
```

### Recommended Workflow for Financial Documents

#### Workflow 1: Native PDFs (not scanned)
```bash
1. Upload PDF to group workspace
2. Run: python extract_tables.py document.pdf
   # Uses pdfplumber or Camelot depending on complexity
3. Agent analyzes extracted CSV tables
4. For narrative content, use marker to convert to Markdown
5. Claude reads Markdown + CSV tables for comprehensive analysis
```

#### Workflow 2: Scanned Documents (receipts, old forms)
```bash
1. Upload image/scanned PDF
2. Run: tesseract document.jpg output.txt
3. Validate OCR output (agent should check for obvious errors)
4. Claude analyzes extracted text
```

#### Workflow 3: Mixed (forms + tables + scanned sections)
```bash
1. Run Marker to identify scanned vs native pages
2. For native pages: pdfplumber/Camelot for tables
3. For scanned pages: Tesseract OCR
4. Combine results into structured Markdown
5. Claude analyzes complete document
```

## Implementation Steps

### Step 1: Choose Your Approach

**For general PDF reading**: Use Claude's native PDF support (no setup needed)

**For financial documents with privacy requirements**: Install local Python stack in container

**For MCP integration**: Add pdf-reader-mcp to settings.json

### Step 2: Install Local Tools (if chosen)

Add to `container/Dockerfile`:
```dockerfile
# Python PDF processing tools
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libgl1-mesa-glx \
    libglib2.0-0

RUN pip install --no-cache-dir \
    pdfplumber \
    camelot-py[cv] \
    opencv-python \
    pytesseract \
    Pillow \
    pandas \
    openpyxl \
    marker-pdf
```

Rebuild container:
```bash
./container/build.sh
```

### Step 3: Create Helper Scripts

Create `container/scripts/extract-tables.py`:
```python
#!/usr/bin/env python3
"""
Extract tables from PDF financial documents.
Tries Camelot first (better for complex tables), falls back to pdfplumber.
"""
import sys
import camelot
import pdfplumber

def extract_tables(pdf_path, output_dir):
    # Try Camelot first (better for bordered tables)
    try:
        tables = camelot.read_pdf(pdf_path, flavor='lattice', pages='all')
        if tables.n > 0:
            print(f"Camelot found {tables.n} tables")
            for i, table in enumerate(tables):
                output = f"{output_dir}/table_{i}.csv"
                table.to_csv(output)
                print(f"  Table {i}: {output} ({table.accuracy}% accuracy)")
            return
    except Exception as e:
        print(f"Camelot failed: {e}, trying pdfplumber...")

    # Fallback to pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        table_count = 0
        for page_num, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            for i, table in enumerate(tables):
                output = f"{output_dir}/table_p{page_num}_{i}.csv"
                import pandas as pd
                df = pd.DataFrame(table[1:], columns=table[0])
                df.to_csv(output, index=False)
                print(f"  Table {table_count}: {output}")
                table_count += 1

if __name__ == '__main__':
    extract_tables(sys.argv[1], sys.argv[2])
```

Make it executable and add to PATH in container:
```dockerfile
COPY scripts/extract-tables.py /usr/local/bin/extract-tables
RUN chmod +x /usr/local/bin/extract-tables
```

### Step 4: Update CLAUDE.md

Add to relevant group CLAUDE.md files:

```markdown
## PDF and Document Processing

### Financial Documents (Tax Forms, Statements, Receipts)

**For privacy and structured data extraction, use local tools:**

```bash
# Extract tables from financial statement
extract-tables /workspace/statement.pdf /workspace/tables/

# OCR a scanned receipt
tesseract /workspace/receipt.jpg /workspace/receipt.txt

# Convert complex PDF to Markdown
marker /workspace/tax_form.pdf --output_dir /workspace/converted
```

**For general PDF reading (non-sensitive):**
- Just ask the user to attach the PDF - Claude can read it natively

### Table Extraction

Tables are saved as CSV files that you can read with pandas or standard tools:

```python
import pandas as pd
df = pd.read_csv('/workspace/tables/table_0.csv')
print(df.head())
```

### OCR Validation

Always validate OCR output for obvious errors:
- Check for garbled characters
- Verify numeric fields (amounts, dates)
- Ask user to confirm critical values

### Privacy Note

Financial documents contain sensitive information. When using local tools:
- Documents stay on the user's machine
- No data sent to external services
- Extracted text/tables saved in workspace (isolated per group)
```

## Tool Comparison Matrix

| Tool | Best For | Table Extraction | OCR | Privacy | Complexity |
|------|----------|------------------|-----|---------|------------|
| Claude Native | General PDFs | Basic text | No | Data sent to Anthropic | Zero setup |
| pdf-reader-mcp | MCP integration | Basic text | No | Can be local | Low |
| pdfplumber | Structured tables | Excellent | No | Local | Medium |
| Camelot | Complex tables | Best-in-class | No | Local | Medium |
| Tesseract | Scanned docs | N/A | Excellent | Local | Low |
| Marker | Conversion to Markdown | Good | No | Local | Low |

## Security and Privacy Considerations

### For Tax and Financial Documents:

1. **Use local processing** (pdfplumber/Camelot/Tesseract) to avoid sending sensitive data to external services

2. **Per-group isolation**: Each registered group has its own workspace (`data/sessions/{group}/`), so documents are isolated

3. **Temporary storage**: Consider adding cleanup scripts to delete processed financial documents after analysis:
   ```bash
   # Add to group's cleanup script
   find /workspace -name "*.pdf" -mtime +7 -delete
   ```

4. **Redaction**: For documents that must be shared with Claude API, redact sensitive info first:
   ```python
   import pdfplumber
   import pandas as pd

   # Extract and redact SSN/account numbers before analysis
   with pdfplumber.open('tax_form.pdf') as pdf:
       text = pdf.pages[0].extract_text()
       text = re.sub(r'\d{3}-\d{2}-\d{4}', 'XXX-XX-XXXX', text)  # SSN
       text = re.sub(r'\d{10,}', 'XXXXXXXXXX', text)  # Account numbers
   ```

## Troubleshooting

### "No tables found"
- Try both Camelot flavors: `flavor='lattice'` (bordered tables) and `flavor='stream'` (text-based)
- Check if PDF is scanned (use Tesseract first, then table extraction)
- Use Marker to convert to Markdown and identify table regions manually

### "OCR produces garbage"
- Ensure image is high quality (300+ DPI)
- Use image preprocessing:
  ```python
  from PIL import Image, ImageEnhance
  img = Image.open('receipt.jpg')
  img = ImageEnhance.Contrast(img).enhance(2)  # Increase contrast
  ```
- Specify language: `pytesseract.image_to_string(img, lang='eng')`

### "Table structure is wrong"
- Camelot has tunable parameters for complex tables:
  ```python
  tables = camelot.read_pdf('doc.pdf',
      flavor='lattice',
      line_scale=40,  # Adjust line detection sensitivity
      table_areas=['10,800,590,20']  # Manual table region
  )
  ```

## What Others Are Using

Based on research of AI assistant implementations:

1. **Personal Finance Bots**: Predominantly use pdfplumber + Tesseract (privacy focus)
2. **Tax Preparation Tools**: Camelot for structured form data extraction
3. **Receipt Scanners**: Tesseract OCR + validation rules
4. **General Assistants**: Claude native PDF API (convenience over privacy)

## Resources

- [pdfplumber documentation](https://github.com/jsvine/pdfplumber)
- [Camelot tutorial](https://camelot-py.readthedocs.io/)
- [Tesseract OCR guide](https://tesseract-ocr.github.io/)
- [Marker examples](https://github.com/VikParuchuri/marker/tree/master/examples)
- [Claude PDF support announcement](https://www.anthropic.com/news/claude-3-5-sonnet)

## Next Steps

1. **Test with sample documents**: Try each tool with representative tax/financial docs
2. **Benchmark accuracy**: Compare table extraction quality across tools
3. **Create templates**: Build reusable scripts for common document types (1040, W-2, bank statements)
4. **Add validation**: Implement checksums and validation rules for financial data
