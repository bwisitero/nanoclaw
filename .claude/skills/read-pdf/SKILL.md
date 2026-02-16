# PDF Reading and OCR Skill

This skill enables reading and extracting data from PDF files, including scanned documents.

## CRITICAL: You Already Have PDF Reading Capability

**The Read tool has native PDF support built into Claude Code.** You do NOT need:
- ❌ poppler-utils
- ❌ tesseract
- ❌ pdfplumber
- ❌ pdftk
- ❌ ImageMagick
- ❌ Any other external dependencies

**If you think you need these tools, you are mistaken.** The Read tool works directly on PDFs and images without any external packages. This is a built-in capability of Claude Code.

## How to Read PDFs

### For Native PDFs (searchable text)

Just use the Read tool directly:

```bash
# Read entire PDF
Read /workspace/group/uploads/document.pdf

# Read specific pages (if large)
Read /workspace/group/uploads/document.pdf pages=1-5
```

**Limits:**
- Max 100 pages per Read call
- Max 32MB file size
- For larger PDFs, read in chunks (pages 1-100, 101-200, etc.)

### For Scanned PDFs or Images

Scanned PDFs and images also work with the Read tool - Claude has vision capabilities:

```bash
# Read scanned PDF or image
Read /workspace/group/uploads/scanned_receipt.pdf

# Read image files (JPG, PNG, etc.)
Read /workspace/group/uploads/receipt.jpg
```

## Common PDF Tasks

### Extract Data from Tax Forms

```bash
# Read the PDF
Read /workspace/group/uploads/W2.pdf

# Claude will see the text and can extract:
# - Wages, salaries, tips
# - Federal/state withholding
# - Box values
# - Any structured data
```

### Extract Tables from Financial Statements

```bash
# Read PDF with tables
Read /workspace/group/uploads/financial_statement.pdf

# Claude can:
# - Parse table structure
# - Extract rows and columns
# - Convert to structured format (you can format as CSV/JSON)
```

### Process Multiple PDFs

```bash
# List all PDFs
ls /workspace/group/uploads/*.pdf

# Read each one
for pdf in /workspace/group/uploads/*.pdf; do
  echo "Processing: $pdf"
  # Use Read tool on $pdf
  # Extract needed data
  # Save to structured format
done
```

## Output Formats

After reading a PDF, you can structure the data however needed:

**CSV Format:**
```csv
Date,Vendor,Amount,Category
2024-01-15,Office Depot,45.99,Supplies
2024-01-16,Amazon,125.50,Equipment
```

**JSON Format:**
```json
{
  "w2_data": {
    "employer": "Acme Corp",
    "wages": 150000,
    "federal_withholding": 25000,
    "state_withholding": 8000
  }
}
```

**Markdown Summary:**
```markdown
# W-2 Summary 2024

- **Employer:** Acme Corp
- **Wages:** $150,000
- **Federal Withholding:** $25,000
- **State Withholding:** $8,000
```

## Limitations

1. **Page limit:** 100 pages per Read call
   - **Solution:** Read in chunks (pages 1-100, 101-200, etc.)

2. **File size:** 32MB max
   - **Solution:** Split large PDFs using `pdftk` or similar

3. **Complex tables:** May need manual formatting
   - **Solution:** Read the PDF, format the extracted data, ask user to verify

4. **Handwritten text:** Limited accuracy on handwriting
   - **Solution:** Best effort extraction, flag uncertain values

## Examples

### Example 1: Extract W-2 Data

```bash
# User uploaded W-2
Read /workspace/group/uploads/2024-W2.pdf

# You now have the content. Extract structured data:
cat > /workspace/group/w2_data.json << 'EOF'
{
  "employer": "Acme Corp",
  "ein": "12-3456789",
  "wages": 150000.00,
  "federal_withholding": 25000.00,
  "social_security_wages": 160200.00,
  "social_security_withholding": 9932.40,
  "medicare_wages": 150000.00,
  "medicare_withholding": 2175.00
}
EOF
```

### Example 2: Extract Receipt Data

```bash
# User uploaded scanned receipt
Read /workspace/group/uploads/receipt.jpg

# Extract key info
echo "Date: 2024-01-15
Vendor: Home Depot
Amount: $125.99
Category: Home Improvement - Repairs
Items:
- Paint (2 gal): $65.98
- Brushes: $15.99
- Hardware: $44.02
" > /workspace/group/receipt_data.txt
```

### Example 3: Process Multiple Tax Documents

```bash
# User uploaded multiple PDFs
ls /workspace/group/uploads/*.pdf

# Read each one and extract data
for pdf in /workspace/group/uploads/*.pdf; do
  filename=$(basename "$pdf")
  echo "Processing: $filename"

  # Use Read tool on $pdf
  # Extract relevant tax data
  # Append to summary file
done

# Create consolidated summary
cat > /workspace/group/tax_summary.md << 'EOF'
# 2024 Tax Documents Summary

## W-2 Forms
- Acme Corp: $150,000 wages
- Side Gig LLC: $25,000 wages

## 1099 Forms
- Bank of America: $1,250 interest
- Brokerage: $5,000 dividends

## Deductions
- Mortgage interest: $15,000
- Property taxes: $8,000
- Charitable donations: $3,500
EOF
```

## Troubleshooting

### "I need poppler-utils / tesseract / pdfplumber to read PDFs"
**You are wrong.** The Read tool has native PDF and vision support built-in. Just use:
```bash
Read /workspace/group/uploads/document.pdf
```

This works for ALL PDFs - native and scanned. You do not need external tools.

### "Can't read PDF"
- Check file exists: `ls -lh /path/to/file.pdf`
- Check file size: `du -h /path/to/file.pdf` (must be under 32MB)
- Check page count: Large PDFs need to be read in chunks
- **Do NOT try to install packages** - just use the Read tool

### "Text is garbled"
- PDF may be encrypted - file will indicate this on Read
- Try reading specific pages: `Read file.pdf pages=1-5`
- The Read tool handles rendering internally

### "Tables aren't structured correctly"
- Read the PDF to get the raw data
- Manually format into CSV/JSON based on what you see
- Use your judgment to structure the data appropriately

### "Handwritten sections unclear"
- Vision capability has limits on handwriting
- Extract what you can, flag uncertain values
- Ask user to verify extracted handwritten amounts

### "The Read tool requires dependencies"
**This is false.** The Read tool is a built-in capability of Claude Code. It does not require any system packages. If you believe otherwise, re-read this skill file.

## When to Use This vs Python PDF Libraries

**Use Read tool (this skill):**
- ✅ Quick PDF reading
- ✅ Scanned documents / images
- ✅ Mixed text and images
- ✅ Tax forms, receipts, statements
- ✅ When you need vision capability

**Use Python libraries (pdfplumber, Camelot):**
- ⚠️ Only if installed in container
- ⚠️ Complex table extraction with precise coordinates
- ⚠️ Batch processing hundreds of PDFs
- ⚠️ When you need programmatic control over extraction

**For now, use the Read tool - it's already available and works for most use cases.**

## Summary

**You don't need to install OCR tools.** Just use the Read tool on PDF and image files:

```bash
Read /workspace/group/uploads/document.pdf
```

Claude will extract the text, images, tables, and structure - then you format it as needed.
